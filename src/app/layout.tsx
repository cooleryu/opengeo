import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import {
  resolveUiLanguageFromHeaderValues,
  UI_LANG_COOKIE_NAME,
} from '@/lib/geo/i18n-server';
import './globals.css';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'OpenGEO · AI Search Visibility Workbench',
  description:
    'Open-source AI search visibility, competitor citation teardown, and optimization workbench.',
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const lang = resolveUiLanguageFromHeaderValues(
    cookieStore.get(UI_LANG_COOKIE_NAME)?.value,
    headerStore.get('accept-language'),
  );
  return (
    <html lang={lang === 'zh' ? 'zh-CN' : 'en'}>
      <body
        style={{
          margin: 0,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        }}
      >
        {children}
      </body>
    </html>
  );
}
