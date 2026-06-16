import Image from "next/image";

const APP_URL = "https://app.dustswap.wtf";
const X_URL = "https://x.com/DustswapOnBase";
const DISCORD_URL = "https://app.dustswap.wtf/discord";
const DOCS_URL = "https://docs.dustswap.wtf";
const INVESTOR_DECK_URL =
  "https://docs.google.com/forms/d/e/1FAIpQLSdH1DhID6_N2N8T9WDiiwjZLT2IskC2Ax0Djoz_5CqvRrW7LQ/viewform?usp=publish-editor";

const footerProductLinks = [
  { label: "Footprint Drop", href: APP_URL },
  { label: "Profile", href: `${APP_URL}/profile` },
  { label: "Swap", href: `${APP_URL}/swap` },
  { label: "Quests", href: `${APP_URL}/quests` },
  { label: "Leaderboard", href: `${APP_URL}/leaderboard` },
] as const;

const navItems = [
  { href: "#product", label: "Product" },
  { href: "#how-it-works", label: "How it Works" },
  { href: "#rewards", label: "Rewards" },
  { href: "#faq", label: "FAQ" },
] as const;

const whyCards = [
  {
    title: "Utility",
    body: "Swap and bridge when you need it.",
    icon: "M7 12h10M12 7l5 5-5 5",
  },
  {
    title: "Progression",
    body: "Track PP, rank, volume, and account momentum.",
    icon: "M5 17l4-4 3 3 7-8",
  },
  {
    title: "Retention",
    body: "Check-ins, quests, referrals, spin rewards, and leaderboard access create repeat behavior.",
    icon: "M12 6v6l4 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  },
] as const;

const loopSteps = [
  {
    title: "Check your Footprint Drop",
    body: "See whether your wallet qualifies based on Base activity.",
  },
  {
    title: "Complete your first check-in",
    body: "Start your progression and unlock more of the app.",
  },
  {
    title: "Build momentum",
    body: "Earn PP, boost progress, spin tickets, and quest activity.",
  },
  {
    title: "Return daily",
    body: "Track rank, move up the leaderboard, and stay active across the product.",
  },
] as const;

const profileCards = [
  {
    title: "Check-in",
    body: "Daily onchain action that moves account progress forward.",
  },
  {
    title: "Referral unlock",
    body: "Participation comes first. Referral access opens after activation.",
  },
  {
    title: "Visible progress",
    body: "Users can see movement, not just collect points blindly.",
  },
] as const;

const stayCards = [
  {
    title: "Daily habit",
    body: "Check-ins create repeat behavior.",
    icon: "M8 7V3m8 4V3M5 11h14M7 21h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v12a2 2 0 002 2z",
  },
  {
    title: "Visible account growth",
    body: "PP, rank, and progress give activity meaning.",
    icon: "M4 19V5m0 14h16M8 16v-4m4 4V8m4 8v-6",
  },
  {
    title: "Structured next steps",
    body: "Quests and referrals guide what users do next.",
    icon: "M9 12l2 2 4-4M7 4h10a2 2 0 012 2v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z",
  },
  {
    title: "Real onchain connection",
    body: "DustSwap stays tied to real product actions, not empty loops.",
    icon: "M12 4l7 4v8l-7 4-7-4V8l7-4zM5 8l7 4 7-4M12 12v8",
  },
] as const;

const faqItems = [
  {
    question: "What is DustSwap?",
    answer:
      "DustSwap is a Base-first product that combines swap utility, progression, rewards, and daily engagement in one connected app.",
  },
  {
    question: "Is this the app?",
    answer:
      "No. This root site explains the product story. Product actions happen at app.dustswap.wtf.",
  },
  {
    question: "What is Footprint Drop?",
    answer:
      "Footprint Drop is a wallet eligibility entry point for Base-active users to discover their PP drop before moving deeper into the app.",
  },
  {
    question: "What can I do in the app?",
    answer:
      "Check Footprint Drop, view Profile, check in, swap, complete quests, use spin tickets, and track leaderboard progress.",
  },
] as const;

function IconPath({ d }: { d: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none">
      <path
        d={d}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817-5.97 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-black uppercase tracking-[0.22em] text-sky-600">
      {children}
    </p>
  );
}

function PrimaryButton({
  children,
  href = APP_URL,
}: {
  children: React.ReactNode;
  href?: string;
}) {
  return (
    <a
      href={href}
      className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-[#145df5] px-6 py-3 text-sm font-black text-white shadow-lift transition hover:-translate-y-0.5 hover:bg-[#0f4ed2] focus:outline-none focus:ring-4 focus:ring-sky-200"
    >
      {children}
    </a>
  );
}

function SecondaryButton({
  children,
  href = APP_URL,
}: {
  children: React.ReactNode;
  href?: string;
}) {
  return (
    <a
      href={href}
      className="inline-flex min-h-12 items-center justify-center rounded-2xl border border-slate-200 bg-white px-6 py-3 text-sm font-black text-slate-900 shadow-[0_12px_28px_rgba(44,83,132,0.08)] transition hover:-translate-y-0.5 hover:border-sky-200 hover:bg-sky-50 focus:outline-none focus:ring-4 focus:ring-sky-100"
    >
      {children}
    </a>
  );
}

function VisualFrame({
  src,
  alt,
  label,
  tone = "blue",
}: {
  src: string;
  alt: string;
  label: string;
  tone?: "blue" | "amber" | "green";
}) {
  const toneClass = {
    blue: "from-sky-50 to-white text-sky-700",
    amber: "from-amber-50 to-white text-amber-700",
    green: "from-emerald-50 to-white text-emerald-700",
  }[tone];

  return (
    <figure className="rounded-[30px] border border-white bg-white p-3 shadow-card">
      <div className={`rounded-[24px] bg-gradient-to-br ${toneClass} p-3`}>
        <div className="overflow-hidden rounded-[20px] border border-white bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
          <Image
            src={src}
            alt={alt}
            width={1200}
            height={900}
            className="h-auto w-full object-cover"
          />
        </div>
        <figcaption className="px-2 pt-3 text-xs font-black uppercase tracking-[0.18em]">
          {label}
        </figcaption>
      </div>
    </figure>
  );
}

function Header() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/80 bg-white/82 shadow-[0_12px_34px_rgba(44,83,132,0.08)] backdrop-blur-2xl">
      <div className="mx-auto flex h-[var(--header-height)] w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <a href="#top" className="inline-flex items-center" aria-label="DustSwap home">
          <Image
            src="/brand/longlogo.png"
            alt="DustSwap"
            width={176}
            height={44}
            priority
            className="h-auto w-[132px] sm:w-[154px]"
          />
        </a>

        <nav className="hidden items-center gap-1 rounded-2xl border border-slate-200/70 bg-white/70 p-1 md:flex">
          {navItems.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-xl px-4 py-2 text-sm font-bold text-slate-600 transition hover:bg-sky-50 hover:text-slate-950"
            >
              {item.label}
            </a>
          ))}
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-xl px-4 py-2 text-sm font-bold text-slate-600 transition hover:bg-sky-50 hover:text-slate-950"
          >
            Docs
          </a>
          <a
            href={X_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="DustSwap on X"
            title="DustSwap on X"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-600 transition hover:bg-sky-50 hover:text-slate-950 focus:outline-none focus:ring-4 focus:ring-sky-100"
          >
            <XIcon />
          </a>
        </nav>

        <div className="hidden md:block">
          <PrimaryButton>Open App</PrimaryButton>
        </div>

        <details className="relative md:hidden">
          <summary
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-800 shadow-[0_10px_24px_rgba(44,83,132,0.1)]"
            aria-label="Open navigation"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none">
              <path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </summary>
          <div className="absolute right-0 top-14 w-[min(82vw,320px)] rounded-[24px] border border-white bg-white/96 p-3 shadow-soft backdrop-blur-2xl">
            <div className="grid gap-1">
              {navItems.map((item) => (
                <a
                  key={item.href}
                  href={item.href}
                  className="rounded-2xl px-4 py-3 text-sm font-bold text-slate-700 hover:bg-sky-50"
                >
                  {item.label}
                </a>
              ))}
              <a
                href={DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="rounded-2xl px-4 py-3 text-sm font-bold text-slate-700 hover:bg-sky-50"
              >
                Docs
              </a>
              <a
                href={X_URL}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-bold text-slate-700 hover:bg-sky-50"
              >
                <XIcon />
                <span>X</span>
              </a>
            </div>
            <div className="mt-3">
              <PrimaryButton>Open App</PrimaryButton>
            </div>
          </div>
        </details>
      </div>
    </header>
  );
}

function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[540px]">
      <Image
        src="/marketing/hero-bg-mesh.png"
        alt=""
        width={1200}
        height={900}
        priority
        aria-hidden="true"
        className="absolute inset-0 h-full w-full rounded-[34px] object-cover opacity-70"
      />
      <div className="relative rounded-[34px] border border-white/90 bg-white/70 p-3 shadow-soft backdrop-blur-xl sm:p-4">
        <Image
          src="/marketing/hero-app-stack.png"
          alt="DustSwap profile, quests, and swap app stack"
          width={1200}
          height={1000}
          priority
          className="h-auto w-full rounded-[28px] border border-white bg-white object-cover shadow-card"
        />
        <div className="pointer-events-none absolute -left-2 top-16 hidden rounded-2xl border border-sky-100 bg-white px-4 py-3 text-sm font-black text-sky-700 shadow-card sm:block">
          PP +2,400
        </div>
        <div className="pointer-events-none absolute -right-2 top-28 hidden rounded-2xl border border-amber-100 bg-white px-4 py-3 text-sm font-black text-amber-700 shadow-card sm:block">
          Rank #128
        </div>
        <div className="pointer-events-none absolute bottom-8 left-8 hidden rounded-2xl border border-emerald-100 bg-white px-4 py-3 text-sm font-black text-emerald-700 shadow-card sm:block">
          Spin Tickets
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section id="top" className="px-4 pb-16 pt-[112px] sm:px-6 lg:px-8 lg:pb-24">
      <div className="mx-auto grid w-full max-w-7xl items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.92fr)]">
        <div>
          <Eyebrow>Built on Base</Eyebrow>
          <h1 className="mt-5 max-w-3xl text-5xl font-black leading-[1.03] text-slate-950 sm:text-6xl lg:text-7xl">
            A better daily DeFi experience on Base.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600 sm:text-xl">
            DustSwap combines swapping, progression, rewards, and daily engagement
            into one Base-first product built for active onchain users.
          </p>

          <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row">
            <PrimaryButton>Open App</PrimaryButton>
            <SecondaryButton>Check Footprint Drop</SecondaryButton>
          </div>

          <p className="mt-6 max-w-2xl text-sm font-bold leading-6 text-slate-500">
            Built for Base <span aria-hidden="true">&bull;</span> Powered by OpenOcean{" "}
            <span aria-hidden="true">&bull;</span> Social + onchain quests{" "}
            <span aria-hidden="true">&bull;</span> Daily progression loop
          </p>
        </div>

        <HeroVisual />
      </div>
    </section>
  );
}

function WhyDustSwap() {
  return (
    <section id="product" className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="max-w-3xl">
          <Eyebrow>Why DustSwap</Eyebrow>
          <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
            Most onchain products optimize for one action. DustSwap is built for return.
          </h2>
          <p className="mt-5 text-base leading-8 text-slate-600 sm:text-lg">
            Users already swap, bridge, claim rewards, and explore opportunities on Base.
            The problem is that most products end the session after one action. DustSwap
            adds progression, visibility, and daily reasons to come back.
          </p>
        </div>

        <div className="mt-9 grid gap-4 md:grid-cols-3">
          {whyCards.map((card) => (
            <article
              key={card.title}
              className="rounded-[28px] border border-white bg-white/88 p-6 shadow-card"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-100 bg-sky-50 text-sky-600">
                <IconPath d={card.icon} />
              </div>
              <h3 className="mt-5 text-xl font-black text-slate-950">{card.title}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-600">{card.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProductLoop() {
  return (
    <section id="how-it-works" className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
              One product. Multiple reasons to come back.
            </h2>
          </div>
          <p className="max-w-md text-base leading-7 text-slate-600">
            A clear loop moves users from first discovery to daily product behavior.
          </p>
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-4">
          {loopSteps.map((step, index) => (
            <article
              key={step.title}
              className="relative rounded-[28px] border border-white bg-white/88 p-6 shadow-card"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#145df5] text-sm font-black text-white">
                {index + 1}
              </div>
              <h3 className="mt-5 text-lg font-black text-slate-950">{step.title}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-600">{step.body}</p>
              {index < loopSteps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute -right-3 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-sky-100 bg-white text-sky-500 shadow-[0_8px_20px_rgba(44,83,132,0.12)] lg:flex"
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
                    <path d="M8 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function FootprintDrop() {
  return (
    <section className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(420px,1fr)]">
        <div>
          <Eyebrow>Attraction layer</Eyebrow>
          <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
            Footprint Drop brings the right users in.
          </h2>
          <p className="mt-5 text-base leading-8 text-slate-600 sm:text-lg">
            DustSwap offers PP drops to Base-active wallets based on onchain activity.
            It gives users a low-friction way to discover the product before moving
            deeper into check-ins, quests, and onchain actions.
          </p>
          <div className="mt-6 grid gap-3 text-sm font-bold text-slate-700 sm:grid-cols-3">
            {["check wallet eligibility", "simple entry point", "built for active Base users"].map((item) => (
              <div key={item} className="rounded-2xl border border-sky-100 bg-white/82 px-4 py-3 shadow-[0_10px_26px_rgba(44,83,132,0.07)]">
                {item}
              </div>
            ))}
          </div>
          <div className="mt-8">
            <PrimaryButton>Check your wallet</PrimaryButton>
          </div>
        </div>

        <VisualFrame
          src="/marketing/footprint-ui.png"
          alt="DustSwap Footprint Drop eligibility preview"
          label="Footprint Drop"
        />
      </div>
    </section>
  );
}

function SwapBridge() {
  return (
    <section className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(420px,1fr)_minmax(0,0.9fr)]">
        <VisualFrame
          src="/marketing/swap-ui.png"
          alt="DustSwap swap and bridge interface preview"
          label="Swap and Bridge"
          tone="green"
        />

        <div>
          <Eyebrow>Utility layer</Eyebrow>
          <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
            Real utility behind the experience.
          </h2>
          <p className="mt-5 text-base leading-8 text-slate-600 sm:text-lg">
            DustSwap is not just a rewards surface. Swap and bridge are core parts
            of the product, giving users a real reason to return beyond campaigns
            and check-ins.
          </p>
          <p className="mt-5 text-base font-black text-slate-950">
            Powered by OpenOcean for trusted routing.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {["Swap on Base", "Bridge across chains", "Utility meets progression"].map((chip) => (
              <span
                key={chip}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-[0_10px_26px_rgba(44,83,132,0.07)]"
              >
                {chip}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProfileActivation() {
  return (
    <section className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(420px,1fr)]">
        <div>
          <Eyebrow>Activation layer</Eyebrow>
          <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
            The profile turns activity into momentum.
          </h2>
          <p className="mt-5 text-base leading-8 text-slate-600 sm:text-lg">
            Profile is where users track PP, rank, swap volume, referral progress,
            and daily account status. Check-in becomes the first real activation
            moment, unlocking more of the product over time.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {profileCards.map((card) => (
              <article
                key={card.title}
                className="rounded-[24px] border border-white bg-white/88 p-5 shadow-card"
              >
                <h3 className="text-base font-black text-slate-950">{card.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-600">{card.body}</p>
              </article>
            ))}
          </div>
        </div>

        <VisualFrame
          src="/marketing/profile-ui.png"
          alt="DustSwap profile and check-in interface preview"
          label="Profile Hub"
          tone="amber"
        />
      </div>
    </section>
  );
}

function SpinQuests() {
  return (
    <section id="rewards" className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="max-w-3xl">
          <Eyebrow>Engagement layer</Eyebrow>
          <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
            Lightweight rewards. Real repeat engagement.
          </h2>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-2">
          <article className="rounded-[30px] border border-white bg-white/88 p-4 shadow-card sm:p-5">
            <VisualFrame
              src="/marketing/spin-ui.png"
              alt="DustSwap spin reward interface preview"
              label="Spin"
              tone="amber"
            />
            <div className="px-2 pt-6">
              <h3 className="text-2xl font-black text-slate-950">Spin</h3>
              <p className="mt-3 text-base leading-7 text-slate-600">
                Spin adds a fun reward loop on top of daily activity. Users receive
                tickets through participation and use them to keep their account moving.
              </p>
            </div>
          </article>

          <article className="rounded-[30px] border border-white bg-white/88 p-4 shadow-card sm:p-5">
            <VisualFrame
              src="/marketing/quests-ui.png"
              alt="DustSwap quests interface preview"
              label="Quests"
            />
            <div className="px-2 pt-6">
              <h3 className="text-2xl font-black text-slate-950">Quests</h3>
              <p className="mt-3 text-base leading-7 text-slate-600">
                Quests turn activity into structured progress. DustSwap combines
                social and onchain tasks to guide users through the product and keep
                the experience active over time.
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function Leaderboard() {
  return (
    <section className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[minmax(420px,1fr)_minmax(0,0.9fr)]">
        <div>
          <div className="mb-4 flex gap-2">
            {["PP", "Referral", "Volume"].map((tab, index) => (
              <span
                key={tab}
                className={`rounded-2xl border px-4 py-2 text-xs font-black uppercase tracking-[0.16em] ${
                  index === 0
                    ? "border-sky-200 bg-sky-50 text-sky-700"
                    : "border-slate-200 bg-white text-slate-500"
                }`}
              >
                {tab}
              </span>
            ))}
          </div>
          <VisualFrame
            src="/marketing/leaderboard-ui.png"
            alt="DustSwap leaderboard interface preview"
            label="Leaderboard"
          />
        </div>

        <div>
          <Eyebrow>Progression layer</Eyebrow>
          <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
            Progress should be visible.
          </h2>
          <p className="mt-5 text-base leading-8 text-slate-600 sm:text-lg">
            DustSwap makes rank, PP, volume, and activity visible so users can feel
            account movement over time. The leaderboard adds competitive energy
            without losing connection to real product activity.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {["visible rank", "user momentum", "community competition"].map((item) => (
              <div key={item} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-[0_10px_26px_rgba(44,83,132,0.07)]">
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function WhyUsersStay() {
  return (
    <section className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="max-w-3xl">
          <Eyebrow>Why it works</Eyebrow>
          <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
            Utility gets users in. Progression keeps them active.
          </h2>
        </div>

        <div className="mt-9 grid gap-4 md:grid-cols-2">
          {stayCards.map((card) => (
            <article
              key={card.title}
              className="rounded-[28px] border border-white bg-white/88 p-6 shadow-card"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-100 bg-sky-50 text-sky-600">
                <IconPath d={card.icon} />
              </div>
              <h3 className="mt-5 text-xl font-black text-slate-950">{card.title}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-600">{card.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-8 rounded-[34px] border border-white bg-white/78 p-6 shadow-card sm:p-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)] lg:p-10">
          <div>
            <Eyebrow>Trust layer</Eyebrow>
            <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
              Built to feel simple. Powered by proven rails.
            </h2>
            <p className="mt-5 text-base leading-8 text-slate-600 sm:text-lg">
              DustSwap is designed to make everyday onchain activity easier to
              understand, easier to repeat, and easier to track.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {[
              "Built for Base users",
              "Powered by OpenOcean routing",
              "Product-first, not campaign-first",
              "Clean progression across one connected app",
            ].map((item) => (
              <div
                key={item}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm font-black text-slate-700 shadow-[0_10px_26px_rgba(44,83,132,0.06)]"
              >
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function FAQ() {
  return (
    <section id="faq" className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="text-center">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="mt-4 text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
            Clear answers before you open the app.
          </h2>
        </div>

        <div className="mt-9 grid gap-3">
          {faqItems.map((item) => (
            <details
              key={item.question}
              className="group rounded-[24px] border border-white bg-white/88 p-5 shadow-card"
            >
              <summary className="flex cursor-pointer items-center justify-between gap-4">
                <span className="text-base font-black text-slate-950">{item.question}</span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-500 transition group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-4 border-t border-slate-100 pt-4 text-sm leading-7 text-slate-600">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCTA() {
  return (
    <section className="px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl overflow-hidden rounded-[36px] border border-white bg-[linear-gradient(135deg,#ffffff_0%,#edf7ff_58%,#fff7e8_100%)] px-6 py-12 text-center shadow-soft sm:px-10 sm:py-16">
        <Image
          src="/brand/longlogo.png"
          alt="DustSwap"
          width={190}
          height={48}
          className="mx-auto h-auto w-[150px]"
        />
        <h2 className="mx-auto mt-7 max-w-3xl text-3xl font-black leading-tight text-slate-950 sm:text-5xl">
          Start with your wallet. Stay for the product.
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-slate-600 sm:text-lg">
          Check your Footprint Drop, explore the app, and see how DustSwap turns
          one-time activity into visible momentum.
        </p>
        <div className="mt-8">
          <PrimaryButton>Open App</PrimaryButton>
        </div>
        <div className="mt-8 flex flex-wrap justify-center gap-5 text-sm font-bold text-slate-500">
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="hover:text-sky-700">
            Docs
          </a>
          <a href={X_URL} target="_blank" rel="noreferrer" className="hover:text-sky-700">
            X
          </a>
          <a href={DISCORD_URL} className="hover:text-sky-700">
            Discord
          </a>
          <a href={APP_URL} className="hover:text-sky-700">
            App
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200/80 bg-white/78 px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div>
            <Image
              src="/brand/longlogo.png"
              alt="DustSwap"
              width={170}
              height={44}
              className="h-auto w-[142px]"
            />
            <p className="mt-5 max-w-sm text-sm leading-7 text-slate-500">
              DustSwap turns swapping, quests, check-ins, referrals, and account
              progress into one connected Base-first experience.
            </p>
          </div>

          <div className="grid gap-8 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-black text-slate-950">Product</h3>
              <div className="mt-4 grid gap-3 text-sm text-slate-500">
                {footerProductLinks.map((item) => (
                  <a key={item.label} href={item.href} className="hover:text-sky-700">
                    {item.label}
                  </a>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-950">Company</h3>
              <div className="mt-4 grid gap-3 text-sm text-slate-500">
                <a href="#product" className="hover:text-sky-700">
                  About
                </a>
                <a
                  href={DOCS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-sky-700"
                >
                  Docs
                </a>
                <a href={X_URL} target="_blank" rel="noreferrer" className="hover:text-sky-700">
                  X
                </a>
                <a href={DISCORD_URL} className="hover:text-sky-700">
                  Discord
                </a>
                <a
                  href={INVESTOR_DECK_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-sky-700"
                >
                  Request Investor Deck
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-slate-200/70 pt-6 text-sm font-bold text-slate-500">
          DustSwap &mdash; a better daily DeFi experience on Base.
        </div>
      </div>
    </footer>
  );
}

export default function HomePage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-cloud text-ink">
      <Header />
      <main>
        <Hero />
        <WhyDustSwap />
        <ProductLoop />
        <FootprintDrop />
        <SwapBridge />
        <ProfileActivation />
        <SpinQuests />
        <Leaderboard />
        <WhyUsersStay />
        <Trust />
        <FAQ />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
