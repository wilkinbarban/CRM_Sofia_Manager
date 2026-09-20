import type { Metadata, Viewport } from 'next'
import './globals.css'

export const viewport: Viewport = {
  themeColor: '#09090b',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

export const metadata: Metadata = {
  metadataBase: new URL('https://crmsofiamanager.duckdns.org'),
  title: {
    default: 'CRM Sofia Manager | Atendimento, Pedidos e IA',
    template: '%s | CRM Sofia Manager',
  },
  description:
    'CRM Sofia Manager: plataforma omnichannel de atendimento inteligente, gestão de pedidos e RAG. Ambiente de demonstração com dados de teste.',
  keywords: [
    'CRM Sofia Manager',
    'Atendimento WhatsApp',
    'Gestão de Pedidos',
    'Atendimento com IA',
    'RAG',
    'Ambiente de demonstração',
  ],
  authors: [{ name: 'CRM Sofia Manager' }],
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon.png', type: 'image/png', sizes: '512x512' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'CRM Sofia Manager | Atendimento, Pedidos e IA',
    description:
      'Plataforma omnichannel de atendimento inteligente, gestão de pedidos e RAG. Ambiente de demonstração com dados de teste.',
    url: 'https://crmsofiamanager.duckdns.org',
    siteName: 'CRM Sofia Manager',
    locale: 'pt_BR',
    type: 'website',
    images: [
      {
        url: '/logo-brasa-sabor.png',
        width: 1024,
        height: 1024,
        alt: 'CRM Sofia Manager — ambiente de demonstração com dados de teste',
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
