export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="glass-card p-8 max-w-lg w-full text-center animate-fade-in">
        <div className="mb-6">
          <h1 className="text-4xl font-bold mb-2">
            <span className="text-gradient">DustSwap</span>
          </h1>
          <p className="text-gray-400 text-lg">
            Sweep your dust tokens into value
          </p>
        </div>

        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-surface-100 border border-white/5">
            <p className="text-sm text-gray-500 mb-1">Status</p>
            <p className="text-dust-purple font-semibold">
              🔧 Setting up MiniApp…
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="p-3 rounded-lg bg-surface-100/50 border border-white/5">
              <p className="text-gray-500">Network</p>
              <p className="text-white font-medium">Base</p>
            </div>
            <div className="p-3 rounded-lg bg-surface-100/50 border border-white/5">
              <p className="text-gray-500">Chain ID</p>
              <p className="text-white font-medium">8453</p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}