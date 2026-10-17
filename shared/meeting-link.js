/** Only turn a complete HTTPS meeting address into a browser link. */
export function meetingLinkUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : '';
  } catch {
    return '';
  }
}

/** Preserve the reviewed text verbatim, linking only the stored meeting URL. */
export function meetingLinkParts(body, meetingUrl) {
  const text = String(body ?? '');
  const href = meetingLinkUrl(meetingUrl);
  if (!href) return [{ text }];
  return text.split(href).flatMap((part, index) => [
    ...(index ? [{ text: href, href }] : []),
    { text: part },
  ]);
}
