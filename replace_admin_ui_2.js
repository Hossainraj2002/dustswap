const fs = require('fs');

const file_path = 'c:/dustswap/apps/web/src/app/admin/quests/page.tsx';
let content = fs.readFileSync(file_path, 'utf-8');

const replacements = {
    'bg-white/5': 'bg-gray-100',
    'hover:bg-white/10': 'hover:bg-gray-50',
    'text-gray-400': 'text-gray-500' // Let's lighten the gray slightly? Wait, text-gray-500 is darker than text-gray-400 in a light theme.
};

for (const [oldVal, newVal] of Object.entries(replacements)) {
    content = content.split(oldVal).join(newVal);
}

fs.writeFileSync(file_path, content, 'utf-8');
console.log('Second pass replacements completed successfully');
