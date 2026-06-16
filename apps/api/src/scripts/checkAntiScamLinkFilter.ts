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
  ["dustswap-wtf.com", false],
  ["dustswap.web.app", false],
  ["dustswapwtf.com", false],
  ["dustswap.claim.xyz", false],
  ["dustswap-wtf.vercel.app", false],
  ["dustswap.wtf.evil.com", false],
  ["bad-dustswap.wtf.evil.com", false],
] as const;

const messageExamples = [
  ["official https://dustswap.wtf and https://x.com/DustswapOnBase", []],
  ["claim now https://dustswap-wtf.vercel.app", ["dustswap-wtf.vercel.app"]],
  ["masked [claim](https://bad.com/path)", ["bad.com"]],
  ["bare domain example.com/path?user=name", ["example.com"]],
  ["many links x.com https://bit.ly/claim https://app.dustswap.wtf", ["bit.ly"]],
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
