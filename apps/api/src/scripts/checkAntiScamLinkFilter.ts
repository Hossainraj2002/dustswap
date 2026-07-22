import {
  findBlockedDomainsInText,
  isAllowedHostname,
  normalizeHostname,
} from "../bots/antiScamLinkFilter";

const allowedDomains = new Set(["x.com", "twitter.com", "dustswap.wtf"]);

const domainExamples = [
  ["x.com", true],
  ["www.twitter.com", true],
  ["dustswap.wtf", true],
  ["app.dustswap.wtf", true],
  ["claims.dustswap.wtf", true],
  // Real subdomains of the allowed X roots are now accepted (mobile app, media).
  ["mobile.x.com", true],
  ["mobile.twitter.com", true],
  ["dustswap-wtf.com", false],
  ["dustswap.web.app", false],
  ["dustswapwtf.com", false],
  ["dustswap.claim.xyz", false],
  ["dustswap-wtf.vercel.app", false],
  // Lookalikes must still be blocked even with generalized subdomain matching.
  ["dustswap.wtf.evil.com", false],
  ["bad-dustswap.wtf.evil.com", false],
  ["x.com.evil.com", false],
] as const;

// Mirrors the shipped DEFAULT_ALLOWED_DOMAINS so we can assert the X ecosystem,
// Discord media CDN, and GIF pickers are accepted while invites stay blocked.
const defaultAllowedDomains = new Set([
  "dustswap.wtf",
  "x.com",
  "twitter.com",
  "t.co",
  "twimg.com",
  "fxtwitter.com",
  "vxtwitter.com",
  "fixupx.com",
  "discordapp.com",
  "discordapp.net",
  "tenor.com",
  "giphy.com",
  "basescan.org",
  "bscscan.com",
  "etherscan.io",
]);

const defaultDomainExamples = [
  ["t.co", true],
  ["pbs.twimg.com", true],
  ["video.twimg.com", true],
  ["fxtwitter.com", true],
  ["cdn.discordapp.com", true],
  ["media.discordapp.net", true],
  ["tenor.com", true],
  ["media.tenor.com", true],
  ["giphy.com", true],
  // Block explorers (official-links + everyday tx sharing).
  ["basescan.org", true],
  ["bscscan.com", true],
  ["etherscan.io", true],
  // Invites and arbitrary domains remain blocked.
  ["discord.gg", false],
  ["discord.com", false],
  ["basescan.org.evil.com", false],
  ["bit.ly", false],
  ["evil.com", false],
] as const;

const messageExamples = [
  ["official https://dustswap.wtf and https://x.com/DustswapOnBase", []],
  ["claim now https://dustswap-wtf.vercel.app", ["dustswap-wtf.vercel.app"]],
  ["masked [claim](https://bad.com/path)", ["bad.com"]],
  ["bare domain example.com/path?user=name", ["example.com"]],
  ["many links x.com https://bit.ly/claim https://app.dustswap.wtf", ["bit.ly"]],
  ["ordinary image filename screenshot.png", []],
  ["ordinary image filename final.banner.JPG", []],
  ["ordinary document filename audit-report.pdf", []],
  ["real URL with image path https://bad.com/screenshot.png", ["bad.com"]],
] as const;

let failures = 0;

for (const [domain, expectedAllowed] of domainExamples) {
  const actualAllowed = isAllowedHostname(domain, allowedDomains);
  if (actualAllowed !== expectedAllowed) {
    failures += 1;
    console.error(
      `Domain example failed: ${domain} normalized=${normalizeHostname(domain)} expected=${expectedAllowed} actual=${actualAllowed}`
    );
  }
}

for (const [domain, expectedAllowed] of defaultDomainExamples) {
  const actualAllowed = isAllowedHostname(domain, defaultAllowedDomains);
  if (actualAllowed !== expectedAllowed) {
    failures += 1;
    console.error(
      `Default domain example failed: ${domain} normalized=${normalizeHostname(domain)} expected=${expectedAllowed} actual=${actualAllowed}`
    );
  }
}

for (const [message, expectedBlocked] of messageExamples) {
  const actualBlocked = findBlockedDomainsInText(message, allowedDomains);
  const expected = expectedBlocked.join(",");
  const actual = actualBlocked.join(",");
  if (actual !== expected) {
    failures += 1;
    console.error(`Message example failed: ${message} expected=${expected} actual=${actual}`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("Anti-scam link filter examples passed.");
}
