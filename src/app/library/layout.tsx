import { Metadata } from 'next';
import React from 'react';
import ResearchLayout from '../research/layout';

export const metadata: Metadata = {
  title: 'Library - Vane',
};

const Layout = ({ children }: { children: React.ReactNode }) => {
  return <ResearchLayout>{children}</ResearchLayout>;
};

export default Layout;
