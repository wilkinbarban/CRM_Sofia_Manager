/**
 * Deprecation Guard:
 * The legacy brand asset generator is deprecated and disabled to retain verified brand assets
 * and preserve file history. New brand assets are permanently integrated as verified static files
 * under apps/web/public and verified by tests/unit/brand-asset-metadata.test.ts.
 */
console.error(
  'Error: scripts/generate-brand-assets.js is deprecated and disabled to prevent overwriting verified brand assets. Retaining verified assets and file history.'
)
process.exit(1)

const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

const publicDir = '/home/wilkin/proyectos/Asados/apps/web/public'

// 1. Criar o SVG vetorial do Logo e Favicon da Casa de Assados Sofia
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#18181b"/>
      <stop offset="50%" stop-color="#09090b"/>
      <stop offset="100%" stop-color="#000000"/>
    </linearGradient>
    <linearGradient id="flameGrad" x1="0%" y1="100%" x2="0%" y2="0%">
      <stop offset="0%" stop-color="#dc2626"/>
      <stop offset="45%" stop-color="#ea580c"/>
      <stop offset="80%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#fef08a"/>
    </linearGradient>
    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#fbbf24"/>
      <stop offset="50%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="12" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Fundo Circular Escuro com Borda Dourada Refinada -->
  <circle cx="256" cy="256" r="246" fill="url(#bgGrad)" stroke="url(#goldGrad)" stroke-width="8"/>
  <circle cx="256" cy="256" r="232" fill="none" stroke="#27272a" stroke-width="2" stroke-dasharray="6,6"/>

  <!-- Chamas da Brasa e Fogo Gastronômico -->
  <g filter="url(#glow)" transform="translate(0, -10)">
    <!-- Brasa de Fundo -->
    <path d="M256 90 C290 170 370 230 370 310 C370 380 320 420 256 420 C192 420 142 380 142 310 C142 230 222 170 256 90 Z" fill="url(#flameGrad)" opacity="0.95"/>
    
    <!-- Língua de Fogo Central -->
    <path d="M256 140 C280 200 330 250 330 310 C330 360 295 395 256 395 C217 395 182 360 182 310 C182 250 232 200 256 140 Z" fill="#fef08a" opacity="0.9"/>
    
    <!-- Coração da Chama -->
    <path d="M256 220 C270 260 295 290 295 325 C295 355 275 375 256 375 C237 375 217 355 217 325 C217 290 242 260 256 220 Z" fill="#ffffff"/>
  </g>

  <!-- Garfo / Espeto de Churrasco & Estrela -->
  <g fill="url(#goldGrad)">
    <circle cx="256" cy="430" r="10"/>
    <path d="M256 410 L256 430" stroke="url(#goldGrad)" stroke-width="6" stroke-linecap="round"/>
  </g>
</svg>`

async function generateBrandAssets() {
  const svgPath = path.join(publicDir, 'logo-casa-de-assados-sofia.svg')
  await fs.promises.writeFile(svgPath, logoSvg)
  console.log('✓ SVG gravado em', svgPath)

  const svgBuffer = Buffer.from(logoSvg)

  // 1. icon.png 512x512
  await sharp(svgBuffer)
    .resize(512, 512)
    .png()
    .toFile(path.join(publicDir, 'icon.png'))
  console.log('✓ icon.png (512x512) gerado')

  // 2. apple-touch-icon.png 180x180
  await sharp(svgBuffer)
    .resize(180, 180)
    .png()
    .toFile(path.join(publicDir, 'apple-touch-icon.png'))
  console.log('✓ apple-touch-icon.png (180x180) gerado')

  // 3. favicon.png 32x32
  await sharp(svgBuffer)
    .resize(32, 32)
    .png()
    .toFile(path.join(publicDir, 'favicon-32x32.png'))

  // 4. favicon.ico (32x32 PNG copiado como favicon.ico para compatibilidade web)
  await sharp(svgBuffer)
    .resize(32, 32)
    .png()
    .toFile(path.join(publicDir, 'favicon.ico'))
  console.log('✓ favicon.ico gerado com sucesso')
}

generateBrandAssets().catch(console.error)
