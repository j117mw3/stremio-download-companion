import fs from 'node:fs';
import path from 'node:path';
const lock=JSON.parse(fs.readFileSync('package-lock.json','utf8'));
const sections=['# Third-party notices\n\nThe application source uses the MIT license. Dependencies retain their own licenses. Electron distributes its LICENSE and Chromium notices with the application. FFmpeg and FFprobe are external prerequisites, not bundled binaries.\n'];
for(const [directory,entry] of Object.entries(lock.packages)){
  if(!directory||entry.dev||!fs.existsSync(path.join(directory,'package.json')))continue;
  const pkg=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
  sections.push(`## ${pkg.name} ${pkg.version}\n\nLicense: ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license||pkg.licenses||'See package notices')}\n`);
  for(const file of fs.readdirSync(directory).filter(name=>/^(licen[sc]e|copying|notice)(\.|$)/i.test(name))){
    const full=path.join(directory,file);if(!fs.statSync(full).isFile())continue;
    sections.push(`### ${file}\n\n\`\`\`text\n${fs.readFileSync(full,'utf8').trim()}\n\`\`\`\n`);
  }
}
fs.writeFileSync('THIRD_PARTY_NOTICES.md',sections.join('\n'));
