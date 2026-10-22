import configManager from '@/lib/config';
import SetupWizard from '@/components/Setup/SetupWizard';
import { ChatProvider } from '@/lib/hooks/useChat';
import ThemeProvider from '@/components/theme/Provider';
import Sidebar from '@/components/Sidebar';
import { Toaster } from 'sonner';
export default function ResearchLayout({children}: {children:React.ReactNode}) {
  return <ThemeProvider>{configManager.isSetupComplete() ? <ChatProvider><Sidebar>{children}</Sidebar><Toaster /></ChatProvider> : <SetupWizard configSections={configManager.getUIConfigSections()} />}</ThemeProvider>;
}
