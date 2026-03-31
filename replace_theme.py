import os
import re

targets = [
    r'apps\web\src\app\dustsweep\page.tsx',
    r'apps\web\src\app\particles\page.tsx',
    r'apps\web\src\app\page.tsx',
    r'apps\web\src\app\leaderboard\page.tsx'
]

# Replacements (dict of ordered mapping)
# Note: we should replace higher specific numbers first to prevent partial matches

replacements = [
    (r'bg-gray-950/95', r'bg-white/95'),
    (r'bg-gray-950', r'bg-slate-50'),
    (r'bg-gray-900/80', r'bg-white/90'),
    (r'bg-gray-900', r'bg-white'),
    (r'bg-gray-800', r'bg-slate-100'),
    (r'bg-gray-700', r'bg-slate-200'),
    
    (r'hover:bg-gray-800', r'hover:bg-slate-100'),
    (r'hover:bg-gray-700', r'hover:bg-slate-200'),
    
    (r'border-gray-800', r'border-slate-200'),
    (r'border-gray-700', r'border-slate-300'),
    (r'border-gray-600', r'border-slate-300'),
    
    (r'hover:border-gray-700', r'hover:border-slate-300'),
    (r'hover:border-gray-600', r'hover:border-purple-300'),

    (r'text-gray-300', r'text-slate-600'),
    (r'text-gray-400', r'text-slate-500'),
    (r'text-gray-500', r'text-slate-400'),
    (r'text-gray-600', r'text-slate-500'),

    (r'hover:text-white', r'hover:text-slate-900'),
    
    (r'text-white', r'text-slate-900'),
    
    (r'bg-black/70', r'bg-slate-900/40'),
    (r'bg-black/60', r'bg-slate-900/40'),
    
    # Custom fix for some specific items
    (r'shadow-black/50', r'shadow-slate-300/40'),
    (r'text-slate-900 font-bold', r'text-slate-900 font-bold'), # keep logic
    
    # Leaderboard specific
    (r'bg-slate-950 text-white', r'bg-white border-slate-200 shadow-sm text-slate-900'),
]

for t in targets:
    if os.path.exists(t):
        with open(t, 'r', encoding='utf-8') as f:
            content = f.read()
            
        for pat, rep in replacements:
            # We must be careful with text-white inside buttons (like sweep button).
            # If the background is a gradient-to-r from-purple-600, it usually means it's a primary button and text should be white.
            # Let's fix text-white replaced with text-slate-900 back to text-white if it's on a button.
            pass
            
        # Instead, let's just do a manual careful re.sub. We'll find all classes="" and modify them.
        
        def class_replacer(match):
            cls_str = match.group(1)
            
            # primary button logic protection
            is_primary_btn = 'from-purple' in cls_str or 'bg-blue-600' in cls_str or 'to-indigo' in cls_str or 'bg-sky-600' in cls_str
            
            # Apply replacements on words inside class
            words = cls_str.split(' ')
            new_words = []
            for w in words:
                if w == 'bg-gray-950/95': w = 'bg-white/95'
                elif w == 'bg-gray-950': w = 'bg-slate-50'
                elif w == 'bg-gray-900/80': w = 'bg-white/90'
                elif w == 'bg-gray-900/95': w = 'bg-white/95'
                elif w == 'bg-gray-900': w = 'bg-white'
                elif w == 'bg-gray-800': w = 'bg-slate-100'
                elif w == 'bg-gray-700': w = 'bg-slate-200'
                elif w == 'hover:bg-gray-800': w = 'hover:bg-slate-50'
                elif w == 'hover:bg-gray-700': w = 'hover:bg-slate-200'
                
                elif w == 'border-gray-800': w = 'border-slate-200'
                elif w == 'border-gray-700': w = 'border-slate-200'
                elif w == 'border-gray-600': w = 'border-slate-300'
                elif w == 'hover:border-gray-700': w = 'hover:border-slate-300'
                elif w == 'hover:border-gray-600': w = 'hover:border-purple-300'
                
                elif w == 'text-gray-300': w = 'text-slate-700'
                elif w == 'text-gray-400': w = 'text-slate-500'
                elif w == 'text-gray-500': w = 'text-slate-500'
                elif w == 'text-gray-600': w = 'text-slate-400'
                
                elif w == 'hover:text-white' and not is_primary_btn: w = 'hover:text-slate-900'
                elif w == 'text-white' and not is_primary_btn: w = 'text-slate-900'
                
                elif w == 'bg-black/70': w = 'bg-slate-800/40'
                
                elif w == 'shadow-black/50': w = 'shadow-slate-300/40'
                elif w == 'border-slate-900': w = 'border-slate-200'
                
                if w == 'bg-slate-950' and 'leaderboard' in t: w = 'bg-white'
                
                new_words.append(w)
                
            return f'className="{ " ".join(new_words) }"'
            
        content = re.sub(r'className="([^"]+)"', class_replacer, content)
        content = re.sub(r"className={`([^`]+)`}", class_replacer, content)
        
        with open(t, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Updated {t}")
