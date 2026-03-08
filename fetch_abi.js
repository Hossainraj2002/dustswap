const fs = require('fs');

async function main() {
    const resV3 = await fetch('https://api.basescan.org/api?module=contract&action=getabi&address=0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a');
    const dataV3 = await resV3.json();
    const abiV3 = JSON.parse(dataV3.result);
    console.log("=== V3 Quoter ===");
    console.log(JSON.stringify(abiV3.filter(f => f.name === 'quoteExactInputSingle'), null, 2));

    const resV4 = await fetch('https://api.basescan.org/api?module=contract&action=getabi&address=0x0d5e0f971ed27fbff6c2837bf31316121532048d');
    const dataV4 = await resV4.json();
    const abiV4 = JSON.parse(dataV4.result);
    console.log("=== V4 Quoter ===");
    console.log(JSON.stringify(abiV4.filter(f => f.name === 'quoteExactInputSingle'), null, 2));
}

main().catch(console.error);
