// scripts/gen-icons.mjs — node scripts/gen-icons.mjs
import sharp from 'sharp'
const svg = (pad) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
     <rect width="512" height="512" rx="${pad ? 0 : 96}" fill="#1E43B8"/>
     <text x="256" y="340" font-family="Arial, sans-serif" font-size="280" font-weight="800"
           fill="#fff" text-anchor="middle">M</text>
   </svg>`)
await sharp(svg(false)).resize(192, 192).png().toFile('public/icons/icon-192.png')
await sharp(svg(false)).resize(512, 512).png().toFile('public/icons/icon-512.png')
await sharp(svg(true)).resize(512, 512).png().toFile('public/icons/maskable-512.png')
console.log('icons generated')
