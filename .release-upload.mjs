import { readFile } from 'node:fs/promises';

const token = process.env.GH_TOKEN;
const repo = 'xiao-benben/archive-assistant';
const v = '0.1.3';
const body = [
  '本次更新：',
  '- 收藏页：单击卡片直接打开文件；卡片右上角新增「定位到实际工作区」和「取消收藏」按钮',
  '- 工作区：详情面板支持一键取消收藏（从所有收藏分区移除）',
  '- 工作区：再次单击已选中文件可取消选中',
].join('\n');

const create = await fetch(`https://api.github.com/repos/${repo}/releases`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  body: JSON.stringify({
    tag_name: `v${v}`, target_commitish: 'main',
    name: `归档助手 v${v}`, body, draft: false, prerelease: false,
  }),
});
const rel = await create.json();
if (!create.ok) { console.log(`创建失败: ${rel.message}`); process.exit(1); }
const buf = await readFile(`src-tauri/target/release/bundle/nsis/归档助手_${v}_x64-setup.exe`);
const name = encodeURIComponent(`archive-assistant_${v}_x64-setup.exe`);
const up = await fetch(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${name}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
  body: buf,
});
const asset = await up.json();
console.log(up.ok ? `v${v} 完成: ${asset.browser_download_url}` : `上传失败: ${asset.message}`);
