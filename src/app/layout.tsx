import type { Metadata } from 'next';
import './globals.css';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'OpenGEO · AI Search Visibility Workbench',
  description:
    'Open-source AI search visibility, competitor citation teardown, and optimization workbench.',
};
export default function RootLayout({children}: {children:React.ReactNode}) {
  return <html lang="en"><body style={{margin:0,fontFamily:'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'}}>{children}</body></html>;
}
