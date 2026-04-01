import sys

file_path = r'c:\dustswap\apps\web\src\app\admin\quests\page.tsx'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

replacements = {
    'text-white': 'text-gray-900',
    'text-gray-300': 'text-gray-600',
    'text-gray-400': 'text-gray-500',
    'text-gray-500': 'text-gray-400',
    'bg-[linear-gradient(180deg,rgba(13,18,31,0.96),rgba(6,9,16,0.96))]': 'bg-white shadow-sm',
    'bg-white/[0.04]': 'bg-white shadow-sm',
    'bg-white/[0.03]': 'bg-gray-50',
    'border-white/10': 'border-gray-200',
    'bg-black/20': 'bg-white',
    'placeholder:text-gray-500': 'placeholder:text-gray-400 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm',
    'bg-white px-5 py-3 text-sm font-semibold text-[#030305] transition hover:bg-sky-100': 'bg-sky-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-sky-700 shadow-sm',
    'border-sky-300/30 bg-sky-400/10 text-[11px] font-bold text-sky-100 transition hover:bg-sky-400/20': 'border-sky-200 bg-sky-50 text-[11px] font-bold text-sky-700 transition hover:bg-sky-100',
    'border-sky-300/20 bg-sky-400/10 px-3 py-3 text-xs leading-6 text-sky-50/90': 'border-sky-200 bg-sky-50 px-3 py-3 text-xs leading-6 text-sky-800',
    'border-white/10 bg-black/20 px-3 py-3 text-[11px] leading-5 text-sky-100': 'border-gray-200 bg-white px-3 py-3 text-[11px] leading-5 text-sky-700',
    'bg-black/30 px-1.5 py-0.5 text-xs text-sky-100': 'bg-sky-50 border border-sky-100 px-1.5 py-0.5 text-xs text-sky-700',
    'border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100': 'border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700',
    'border-emerald-400/20 bg-emerald-500/10 text-emerald-100': 'border-emerald-200 bg-emerald-50 text-emerald-700',
    'border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100': 'border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700',
    'text-sky-200/70': 'text-sky-600',
    'text-sky-200': 'text-sky-600 hover:text-sky-700',
    'border-white/10 bg-white/5 text-gray-300': 'border-gray-200 bg-gray-100 text-gray-600',
    'border-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10': 'border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50',
    'border-rose-400/20 px-4 py-2 text-sm font-medium text-rose-100 transition hover:bg-rose-500/10': 'border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 bg-white',
    'border-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/10': 'border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50',
    'outline-none': 'outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm'
}

for old, new in replacements.items():
    content = content.replace(old, new)


with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)
