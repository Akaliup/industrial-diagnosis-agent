#!/usr/bin/env node
/**
 * 从仓库根目录的高清品牌源图生成 Web、PWA、Apple Touch 与 Electron 图标。
 *
 * 源图：branding/industrial-diagnosis-icon-source.png
 * 源图四角是纯黑底；生成时用与图标圆角一致的遮罩去掉黑角，视觉主体不变。
 * 保留旧的 logo-1024.png 回退路径，便于没有品牌目录的裁剪构建。
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webDir = join(__dirname, '..');
const repoRoot = join(webDir, '..');
const publicDir = join(webDir, 'public', 'icons');
const electronAssetsDir = join(repoRoot, 'electron', 'assets');

const sizes = [48, 72, 96, 128, 144, 152, 192, 384, 512];
// 源图内圆角约占边长的 23%，四周约 1.6% 是纯黑。遮罩略微内收，
// 只去掉圆角外的黑底，不改变图标内部的任何像素。
const SOURCE_INSET_RATIO = 0.016;
const SOURCE_RADIUS_RATIO = 0.2313;
const MASKABLE_BACKGROUND = { r: 30, g: 34, b: 45, alpha: 1 };

function resolveSource() {
  const brandingPath = join(
    repoRoot,
    'branding',
    'industrial-diagnosis-icon-source.png',
  );
  if (existsSync(brandingPath)) return { path: brandingPath, branded: true };
  const logo1024Path = join(publicDir, 'logo-1024.png');
  if (existsSync(logo1024Path)) return { path: logo1024Path, branded: false };
  return { path: join(webDir, 'public', 'favicon.svg'), branded: false };
}

async function roundedMaster(sourceBuffer, branded) {
  const image = sharp(sourceBuffer).ensureAlpha();
  if (!branded) return image.png().toBuffer();

  const { width, height } = await image.metadata();
  const inset = Math.round(width * SOURCE_INSET_RATIO);
  const radius = Math.round(width * SOURCE_RADIUS_RATIO);
  const mask = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${height - inset * 2}" ` +
      `rx="${radius}" ry="${radius}" fill="#ffffff"/></svg>`,
  );
  return sharp(sourceBuffer)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function writePng(input, size, outputPath) {
  await sharp(input).resize(size, size).png().toFile(outputPath);
  console.log(`✓ ${outputPath.replace(repoRoot + '\\', '')} (${size}x${size})`);
}

async function writeMaskable(master, size, outputPath) {
  // Maskable 安全区是直径 80% 的圆；图标整体缩到 80% 并居中，
  // 背景取源图圆角边缘的深海军蓝，裁切后不会露出黑角。
  const innerSize = Math.round(size * 0.8);
  const padding = Math.floor((size - innerSize) / 2);
  const inner = await sharp(master)
    .resize(innerSize, innerSize)
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: MASKABLE_BACKGROUND,
    },
  })
    .composite([{ input: inner, top: padding, left: padding }])
    .png()
    .toFile(outputPath);
  console.log(
    `✓ ${outputPath.replace(repoRoot + '\\', '')} (${size}x${size}, maskable 80% safe area)`,
  );
}

async function writeOpaque(master, size, outputPath) {
  const inner = await sharp(master).resize(size, size).png().toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: MASKABLE_BACKGROUND,
    },
  })
    .composite([{ input: inner, top: 0, left: 0 }])
    .png()
    .toFile(outputPath);
  console.log(
    `✓ ${outputPath.replace(repoRoot + '\\', '')} (${size}x${size}, opaque)`,
  );
}

/**
 * 生成 PNG 编码的 ICNS。ICNS 容器 = 8 字节头 + 若干
 * (4 字节类型 + 4 字节大端长度 + PNG 数据) 块。
 * macOS 10.7+ 支持 ic07/ic08/ic09/ic10 这些 PNG 类型。
 */
async function writeIcns(master, outputPath) {
  const entries = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
  ];
  const chunks = [];
  for (const [type, size] of entries) {
    const png = await sharp(master).resize(size, size).png().toBuffer();
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    chunks.push(header, png);
  }
  const total = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(total, 4);
  writeFileSync(outputPath, Buffer.concat([head, ...chunks]));

  // 回读校验容器长度与每个块，避免写出损坏的 .icns 却报告成功。
  const written = readFileSync(outputPath);
  if (
    written.toString('ascii', 0, 4) !== 'icns' ||
    written.readUInt32BE(4) !== written.length
  ) {
    throw new Error(`ICNS 容器校验失败：${outputPath}`);
  }
  let offset = 8;
  const seen = [];
  while (offset < written.length) {
    const type = written.toString('ascii', offset, offset + 4);
    const length = written.readUInt32BE(offset + 4);
    const png = written.subarray(offset + 8, offset + length);
    if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
      throw new Error(`ICNS ${type} 不是 PNG 数据`);
    }
    seen.push(`${type}:${length}`);
    offset += length;
  }
  if (offset !== written.length) throw new Error('ICNS 块长度不一致');
  console.log(
    `✓ ${outputPath.replace(repoRoot + '\\', '')} (${written.length} bytes; ${seen.join(', ')})`,
  );
}

async function generateIcons() {
  const { path: sourcePath, branded } = resolveSource();
  console.log(`Using source: ${sourcePath}`);
  const sourceBuffer = readFileSync(sourcePath);
  const master = await roundedMaster(sourceBuffer, branded);

  // 统一源图：Web / README 使用同一张 1024 PNG。
  await writePng(master, 1024, join(publicDir, 'logo-1024.png'));

  for (const size of sizes) {
    await writePng(master, size, join(publicDir, `icon-${size}.png`));
  }

  await writeMaskable(master, 512, join(publicDir, 'icon-512-maskable.png'));
  // iOS 不接受透明图标，Apple Touch 用不透明底合成。
  await writeOpaque(master, 180, join(publicDir, 'apple-touch-icon-180.png'));

  await writePng(master, 1024, join(electronAssetsDir, 'app-icon.png'));
  await writeIcns(master, join(electronAssetsDir, 'app.icns'));

  console.log('\n✅ All icons generated successfully!');
}

generateIcons().catch((error) => {
  console.error('❌ Error generating icons:', error);
  process.exit(1);
});
