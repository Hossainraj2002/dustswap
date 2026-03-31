const fs = require('fs');

const files = [
  'apps/web/src/app/dustsweep/page.tsx',
  'apps/web/src/app/particles/page.tsx',
  'apps/web/src/app/leaderboard/page.tsx',
  'apps/web/src/app/page.tsx'
];

const replacements = [
  { p: /bg-gray-950\/95/g, r: 'bg-white/95' },
  { p: /bg-gray-950/g, r: 'bg-slate-50' },
  { p: /bg-gray-900\/80/g, r: 'bg-white border-slate-200 shadow-sm' },
  { p: /bg-gray-900\/95/g, r: 'bg-white/95 border-slate-200' },
  { p: /bg-gray-900/g, r: 'bg-white border-slate-200' },
  { p: /bg-gray-800/g, r: 'bg-slate-100 border-slate-200' }, // Simplification
  { p: /bg-gray-700/g, r: 'bg-slate-200' },
  { p: /hover:bg-gray-800/g, r: 'hover:bg-slate-50' },
  { p: /hover:bg-gray-700/g, r: 'hover:bg-slate-200' },
  
  { p: /border-gray-800/g, r: 'border-slate-200' },
  { p: /border-gray-700/g, r: 'border-slate-300' },
  { p: /border-gray-600/g, r: 'border-slate-300' },
  { p: /hover:border-gray-700/g, r: 'hover:border-slate-300' },
  { p: /hover:border-gray-600/g, r: 'hover:border-purple-300' },

  { p: /text-gray-300/g, r: 'text-slate-700' },
  { p: /text-gray-400/g, r: 'text-slate-500' },
  { p: /text-gray-500/g, r: 'text-slate-400' },
  { p: /text-gray-600/g, r: 'text-slate-500' },

  { p: /hover:text-white/g, r: 'hover:text-slate-900' },
  
  { p: /bg-black\/70/g, r: 'bg-slate-800/40' },
  { p: /bg-black\/60/g, r: 'bg-slate-800/40' },
  { p: /shadow-black\/50/g, r: 'shadow-slate-300/40' },
];

files.forEach(file => {
  if (fs.existsSync(file)) {
    let content = fs.readFileSync(file, 'utf8');
    
    // Process text-white separately to avoid replacing inside gradients
    content = content.replace(/className=(["'{`])(.*?)(["'}`])/g, (match, prefix, classNames, suffix) => {
      let result = classNames;
      
      const isPrimaryBtn = result.includes('from-purple') || result.includes('to-indigo') || result.includes('bg-purple-600');
      
      replacements.forEach(({p, r}) => {
        result = result.replace(p, r);
      });
      
      if (!isPrimaryBtn) {
         result = result.replace(/text-white/g, 'text-slate-900');
      }
      
      return `className=${prefix}${result}${suffix}`;
    });

    // Cleanup redundant classes (e.g. border-slate-200 border-slate-200)
    content = content.replace(/border-slate-[0-9]+ border-slate-[0-9]+/g, 'border-slate-200');
    content = content.replace(/bg-white border-slate-200 border border-slate-200/g, 'bg-white border border-slate-200');

    fs.writeFileSync(file, content, 'utf8');
    console.log(`Updated ${file}`);
  }
});
