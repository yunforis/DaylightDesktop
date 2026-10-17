export function speechSupport(environment) {
  const Recognition = environment?.SpeechRecognition || environment?.webkitSpeechRecognition;
  if (environment?.isSecureContext === false) {
    return { message: '语音输入需要安全页面，请使用 http://127.0.0.1:3000、localhost 或 HTTPS。' };
  }
  if (!Recognition) {
    return { message: '当前浏览器不支持语音识别，请在支持 Web Speech 的浏览器中打开，或直接输入文字。' };
  }
  return { Recognition, message: '' };
}

export function speechErrorMessage(code) {
  const messages = {
    'not-allowed': '未获准使用麦克风。请在地址栏的网站权限中允许麦克风，再点击重试。',
    NotAllowedError: '未获准使用麦克风。请在地址栏的网站权限中允许麦克风，再点击重试。',
    SecurityError: '浏览器阻止了语音输入，请检查网站的麦克风权限，并使用本机地址或 HTTPS。',
    'service-not-allowed': '当前浏览器不允许使用语音识别服务，请检查浏览器的语音权限或换一个浏览器。',
    'audio-capture': '无法使用麦克风，请检查设备连接、系统权限，以及麦克风是否被其他程序占用。',
    NotReadableError: '无法使用麦克风，请检查设备连接、系统权限，以及麦克风是否被其他程序占用。',
    'no-speech': '没有听清语音，请靠近麦克风再试一次，也可以直接输入文字。',
    network: '无法连接浏览器的语音识别服务。请检查网络或更换浏览器，也可以直接输入文字。',
    'language-not-supported': '当前语音识别服务不支持中文，请更换浏览器，或直接输入文字。',
    aborted: '语音输入已中断，已识别的文字仍保留，可以编辑后发送。',
  };
  return messages[code] || '语音识别失败，请检查麦克风和浏览器权限后重试，也可以直接输入文字。';
}

// Each result event contains the session's full result list, including revised interim text.
export function createSpeechInput({ Recognition, initialText = '', onText, onStatus, onEnd }) {
  const recognition = new Recognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;
  let active = true;
  let stopping = false;
  let transcript = '';

  function detach() {
    active = false;
    recognition.onstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
  }

  function finish(error = '') {
    if (!active) return;
    detach();
    onStatus('idle');
    onEnd({ transcript, error });
  }

  function stop() {
    if (!active || stopping) return;
    stopping = true;
    onStatus('processing');
    try { recognition.stop(); } catch (error) {
      // Some browsers only allow stop() after onstart; finish the stop there.
      if (error.name !== 'InvalidStateError') finish(speechErrorMessage(error.name));
    }
  }

  recognition.onstart = () => {
    if (!active) return;
    if (stopping) {
      try { recognition.stop(); } catch (error) { finish(speechErrorMessage(error.name)); }
    } else {
      onStatus('listening');
    }
  };
  recognition.onresult = (event) => {
    if (!active) return;
    transcript = Array.from(event.results, (result) => result[0]?.transcript || '').join('').trim();
    const separator = initialText && transcript && !/\s$/.test(initialText) ? ' ' : '';
    onText(`${initialText}${separator}${transcript}`);
  };
  recognition.onerror = (event) => finish(speechErrorMessage(event.error));
  recognition.onend = () => finish(transcript ? '' : speechErrorMessage('no-speech'));

  return {
    start() {
      onStatus('starting');
      try { recognition.start(); } catch (error) { finish(speechErrorMessage(error.name)); }
    },
    stop,
    cancel() {
      // Sending, editing, closing, and unmounting must ignore any late browser callbacks.
      detach();
      try {
        if (recognition.abort) recognition.abort();
        else recognition.stop();
      } catch { /* The browser may have already ended recognition. */ }
    },
  };
}
