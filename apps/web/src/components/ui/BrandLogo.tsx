import React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { resolveBusinessProfileSync, DEFAULT_BUSINESS_PROFILE } from '@/lib/config/business-profile'

interface BrandLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl'
  showSubtitle?: boolean
  href?: string
  className?: string
  brandName?: string
  subtitle?: string
}

export function BrandLogo({
  size = 'md',
  showSubtitle = true,
  href,
  className = '',
  brandName,
  subtitle,
}: BrandLogoProps) {
  const sizeMap = {
    sm: { img: 28, title: 'text-sm', sub: 'text-[10px]' },
    md: { img: 36, title: 'text-base', sub: 'text-xs' },
    lg: { img: 44, title: 'text-lg', sub: 'text-xs' },
    xl: { img: 56, title: 'text-xl', sub: 'text-sm' },
  }

  const currentSize = sizeMap[size]
  const profile = resolveBusinessProfileSync()
  const displayBrandName = brandName || profile.name
  const isDefault = displayBrandName === DEFAULT_BUSINESS_PROFILE.name
  const displaySubtitle = subtitle || (isDefault ? 'Tradição no Umbará • Curitiba' : profile.location)

  const content = (
    <div className={`flex items-center gap-3 select-none ${className}`}>
      <div className="relative flex items-center justify-center shrink-0 drop-shadow-md">
        <Image
          src="/logo-brasa-sabor.png"
          alt={displayBrandName}
          width={currentSize.img}
          height={currentSize.img}
          priority
          className="rounded-full shadow-md shadow-amber-950/30"
        />
      </div>
      <div className="flex flex-col">
        <div className="flex items-center gap-1.5 leading-tight">
          {isDefault ? (
            <span className={`font-bold tracking-tight text-zinc-100 ${currentSize.title}`}>
              Casa de Assados <span className="text-amber-400 font-extrabold">Brasa &amp; Sabor</span>
            </span>
          ) : (
            <span className={`font-bold tracking-tight text-zinc-100 ${currentSize.title}`}>
              <span className="text-amber-400 font-extrabold">{displayBrandName}</span>
            </span>
          )}
        </div>
        {showSubtitle && (
          <span className={`text-zinc-400 font-medium tracking-wide ${currentSize.sub}`}>
            {displaySubtitle}
          </span>
        )}
      </div>
    </div>
  )

  if (href) {
    return (
      <Link href={href} className="hover:opacity-90 transition-opacity">
        {content}
      </Link>
    )
  }

  return content
}

export default BrandLogo
