// Convert a browser cookie export to Playwright cookies without exposing values.
function normalizeCookies(data) {
  if (!Array.isArray(data) || !data.length || data.length > 200) throw new Error('Cookie file must contain a non-empty JSON array (max 200 cookies)');
  return data.map((cookie, i) => {
    if (!cookie || typeof cookie !== 'object' || typeof cookie.name !== 'string' || !cookie.name || typeof cookie.value !== 'string') throw new Error(`Invalid cookie at index ${i}`);
    const domain = typeof cookie.domain === 'string' ? cookie.domain.toLowerCase() : '';
    if (!['deepseek.com', '.deepseek.com', 'chat.deepseek.com', '.chat.deepseek.com'].includes(domain)) throw new Error(`Cookie at index ${i} is not for deepseek.com`);
    const cookiePath = typeof cookie.path === 'string' && cookie.path.startsWith('/') ? cookie.path : '/';
    const result = { name: cookie.name, value: cookie.value, secure: cookie.secure === true, httpOnly: cookie.httpOnly === true };
    if (cookie.hostOnly === true) result.url = `https://${domain.replace(/^\./, '')}${cookiePath}`;
    else { result.domain = domain; result.path = cookiePath; }
    if (cookie.session !== true && cookie.expirationDate != null) {
      const expires = Number(cookie.expirationDate);
      if (!Number.isFinite(expires) || expires <= 0) throw new Error(`Invalid expiration at index ${i}`);
      result.expires = expires;
    }
    const sameSite = { strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None' }[String(cookie.sameSite || '').toLowerCase()];
    if (sameSite) result.sameSite = sameSite;
    return result;
  });
}
module.exports = { normalizeCookies };
