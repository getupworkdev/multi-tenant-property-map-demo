import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Property Map Demo',
  description: 'Demo: multi-tenant property map with PostGIS, row-level security, CSV import and CRM matching. Fictional data.',
  robots: { index: false },
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>
        <div className="banner">Demo only. Fictional companies, properties and owners. No real LightBox or GoHighLevel data.</div>
        {children}
      </body>
    </html>
  )
}
