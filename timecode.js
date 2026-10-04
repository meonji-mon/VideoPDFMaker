(function (root) {
  function formatDigits(value) {
    const digits = String(value).replace(/\D/g, '').slice(0, 6);
    return digits.match(/.{1,2}/g)?.join(':') || '';
  }
  function parse(value) {
    if (!/^\d{2}:\d{2}:\d{2}$/.test(value)) return null;
    const [hours, minutes, seconds] = value.split(':').map(Number);
    if (minutes > 59 || seconds > 59) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }
  function format(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00';
    const total = Math.floor(seconds);
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
      .map(n => String(n).padStart(2, '0')).join(':');
  }
  const api = { formatDigits, parse, format };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Timecode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
