import path from 'node:path';
import {fileURLToPath} from 'node:url';
import qrterm from 'qrcode-terminal';
import {assertPairingDestination, writePairedCredentials} from '@dot-bridge/core/channels/pairing.js';
import {loginWithQr} from '../src/login.js';

const fail = reason => Object.assign(new Error('Weixin login did not complete.'), {reason});
const help = `微信 iLink 扫码接入\n\nnode scripts/login.js --credentials-file <私有文件绝对路径> --confirm-private-storage --confirm-stopped\n\n先停止同一账号的旧消费者，以最终运行用户执行。已有文件不会覆盖。\n二维码只在当前交互终端显示，五分钟内由本人扫码并确认；不要录屏或重定向输出。\n确认会将官方新签发的登录凭据及扫码本人绑定保存到指定私有文件。\n此命令不会启动消息收发或创建 dot 事件订阅。\n`;

export function readHiddenCode({input = process.stdin, output = process.stdout, signal, retry = false} = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function' || signal?.aborted) return Promise.reject(fail('login_cancelled'));
  output.write(retry ? '数字不匹配，请重新输入手机微信显示的数字（不回显）：' : '请输入手机微信显示的数字（不回显）：');
  return new Promise((resolve, reject) => {
    let value = '', settled = false; const wasRaw = input.isRaw === true, wasPaused = input.isPaused();
    const finish = error => {
      if (settled) return; settled = true;
      input.removeListener('data', data); input.removeListener('end', ended); input.removeListener('error', ended);
      signal?.removeEventListener('abort', aborted); input.setRawMode(wasRaw); if (wasPaused) input.pause();
      output.write('\n'); const result = value; value = '';
      if (error) reject(error); else resolve(result);
    };
    const aborted = () => finish(fail('login_cancelled'));
    const ended = () => finish(fail('login_cancelled'));
    const data = chunk => {
      for (const char of String(chunk)) {
        if (char === '\u0003' || char === '\u0004') { finish(fail('login_cancelled')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (/^[0-9]$/u.test(char) && value.length < 16) value += char;
        else { finish(fail('verification_invalid')); return; }
      }
    };
    input.setRawMode(true); input.on('data', data); input.once('end', ended); input.once('error', ended);
    signal?.addEventListener('abort', aborted, {once: true}); input.resume();
    if (signal?.aborted) aborted();
  });
}

function terminalUi(input, output) {
  let entered = false;
  const clear = () => { if (entered) output.write('\u001b[2J\u001b[H'); };
  return {
    showQr(content) {
      let pixels; qrterm.generate(content, {small: true}, value => { pixels = value; });
      output.write('\u001b[?1049h'); entered = true; clear();
      output.write('请用本人微信扫描并确认授权，二维码最多保留五分钟。\n\n' + pixels + '\n');
    },
    readVerificationCode: options => { clear(); return readHiddenCode({input, output, ...options}); },
    onState(state) { if (state === 'scanned') { clear(); output.write('已扫码，等待微信确认。\n'); } },
    close() { if (entered) { clear(); output.write('\u001b[?1049l'); entered = false; } },
  };
}

export async function runLogin(args, {input = process.stdin, output = process.stdout, login = loginWithQr,
  assertDestination = assertPairingDestination, write = writePairedCredentials, ui, signal} = {}) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { output.write(help); return {help: true}; }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--credentials-file', '--confirm-private-storage', '--confirm-stopped'].includes(key) || Object.hasOwn(options, key)) throw fail('arguments_invalid');
    options[key] = key.startsWith('--confirm-') ? true : args[++i];
  }
  if (options['--confirm-private-storage'] !== true || options['--confirm-stopped'] !== true) throw fail('confirmation_required');
  const file = options['--credentials-file'];
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) throw fail('private_destination_unavailable');
  if (!input.isTTY || !output.isTTY) throw fail('interactive_terminal_required');
  if (signal?.aborted) throw fail('login_cancelled');
  try { assertDestination(file); } catch { throw fail('private_destination_unavailable'); }
  const terminal = ui ?? terminalUi(input, output);
  try {
    const credentials = await login({confirmStopped: true, signal, showQr: terminal.showQr,
      readVerificationCode: terminal.readVerificationCode, onState: terminal.onState});
    if (signal?.aborted) throw fail('login_cancelled');
    try { write(file, credentials); } catch { throw fail('private_destination_unavailable'); }
  } finally { terminal.close(); }
  output.write('微信本人绑定已确认，登录凭据已写入指定私有文件。下一步配置服务，再由原 dot 建立订阅。\n');
  return {paired: true, credentialsSaved: true};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const known = new Set(['arguments_invalid', 'confirmation_required', 'private_destination_unavailable', 'interactive_terminal_required',
    'login_cancelled', 'login_expired', 'login_request_failed', 'login_response_invalid', 'qr_display_unavailable',
    'verification_required', 'verification_invalid', 'verification_blocked', 'already_bound', 'unsupported_login_region', 'owner_evidence_missing']);
  try { await runLogin(process.argv.slice(2), {signal: controller.signal}); }
  catch (error) { process.stderr.write('微信接入未完成：' + (known.has(error?.reason) ? error.reason : 'login_failed') + '。未输出凭据或身份值。\n'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
