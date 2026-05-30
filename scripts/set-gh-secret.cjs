#!/usr/bin/env node
/**
 * Set (or update) a GitHub Actions repository secret.
 *
 *   GH_TOKEN=... node scripts/set-gh-secret.cjs <owner/repo> <SECRET_NAME> <value>
 *
 * Encrypts the value with the repo's public key (libsodium sealed box), as the
 * GitHub API requires. One-off helper — not part of the build.
 */
const sodium = require('libsodium-wrappers');

async function ghApi(token, urlPath, opts = {}) {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'strata-set-secret',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} on ${urlPath}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

(async () => {
  const [repo, name, value] = process.argv.slice(2);
  const token = process.env.GH_TOKEN;
  if (!repo || !name || !value) { console.error('Usage: node set-gh-secret.cjs <owner/repo> <NAME> <value>'); process.exit(1); }
  if (!token) { console.error('GH_TOKEN env required'); process.exit(1); }

  await sodium.ready;
  const pk = await ghApi(token, `/repos/${repo}/actions/secrets/public-key`);
  const binKey = sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL);
  const binVal = sodium.from_string(value);
  const encrypted = sodium.crypto_box_seal(binVal, binKey);
  const encrypted_value = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);

  await ghApi(token, `/repos/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ encrypted_value, key_id: pk.key_id }),
  });
  console.log(`✓ secret ${name} set on ${repo}`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
