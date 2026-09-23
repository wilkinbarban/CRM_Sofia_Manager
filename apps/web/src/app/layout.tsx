import type { Metadata, Viewport } from 'next'
import './globals.css'
import { resolveBusinessProfileSync } from '@/lib/config/business-profile'

const profile = resolveBusinessProfileSync()

export const viewport: Viewport = {
  themeColor: '#09090b',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export const metadata: Metadata = {
  metadataBase: new URL('https://crmsofiamanager.duckdns.org'),
  title: {
    default: `CRM Sofia Manager | ${profile.name}`,
    template: '%s | CRM Sofia Manager',
  },
  description:
    `CRM Sofia Manager: Plataforma omnichannel de atendimento inteligente, gestão de pedidos e RAG para ${profile.name} (${profile.location}).`,
  keywords: [
    'CRM Sofia Manager',
    profile.name,
    profile.shortName,
    'Atendimento Inteligente',
    'Curitiba',
  ],
  authors: [{ name: profile.name }],
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon.png', type: 'image/png', sizes: '512x512' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: `${profile.name} | Atendimento Inteligente & Gestão de Pedidos`,
    description: profile.description,
    url: 'https://crmsofiamanager.duckdns.org',
    siteName: profile.name,
    locale: 'pt_BR',
    type: 'website',
    images: [
      {
        url: '/icon.png',
        width: 512,
        height: 512,
        alt: `${profile.name} - Atendimento Inteligente`,
      },
    ],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="pt-BR" className="h-full antialiased dark">
      <body className="min-h-full flex flex-col font-sans bg-zinc-950 text-zinc-50 selection:bg-amber-500/30 selection:text-amber-200">
        {children}
      </body>
    </html>
  )
}
