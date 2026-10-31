import type { Metadata } from 'next';
import './globals.css';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'OpenGEO · 持续改进工作台', description: '项目 的内容、搜索可见性和持续改进任务。' };
export default function RootLayout({children}: {children:React.ReactNode}) {
  return <html lang="zh-CN"><body style={{margin:0,fontFamily:'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'}}>{children}</body></html>;
}
