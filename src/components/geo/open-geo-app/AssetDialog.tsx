'use client';

import { ArrowUpRight, FileText } from 'lucide-react';
import type { Dispatch, JSX, SetStateAction } from 'react';
import type { GeoAsset } from '@/lib/geo/types';
import { useUiLanguage } from '../UiLanguageContext';
import { assetStatusLabel, assetTypeLabel } from './asset-labels';
import { MarkdownBody } from './MarkdownBody';
import { Modal } from './Modal';

type AssetDialogProps = {
  asset: GeoAsset;
  setAsset: Dispatch<SetStateAction<GeoAsset | null>>;
  evidenceLinks: (paths: string[]) => JSX.Element;
};

export function AssetDialog({
  asset,
  setAsset,
  evidenceLinks,
}: AssetDialogProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <Modal
      title={asset.title}
      description={`${assetTypeLabel(asset.type, isEn)} · ${
            asset.language === 'zh-CN'
              ? isEn
                ? 'Chinese'
                : '中文'
              : asset.language === 'en'
                ? isEn
                  ? 'English'
                  : '英文'
                : asset.language
          } · ${assetStatusLabel(asset.status, isEn)}`}
      onClose={() => setAsset(null)}
      wide
    >
      <div className="og-document-toolbar">
        <span>
          <FileText size={14} />{' '}
          {asset.markdownIsExcerpt
            ? isEn
              ? 'Saved excerpt'
              : '已保存摘录'
            : isEn
              ? 'Saved content'
              : '已保存正文'}
        </span>
        {asset.publicUrl && (
          <a
            className="og-button secondary"
            href={asset.publicUrl}
            target="_blank"
            rel="noreferrer"
          >
            {isEn ? 'Open live page' : '查看线上页面'}{' '}
            <ArrowUpRight size={14} />
          </a>
        )}
      </div>
      <div className="og-document-body">
        <MarkdownBody content={asset.markdown} />
        <div className="og-document-source">
          <strong>{isEn ? 'Sources & evidence' : '来源与依据'}</strong>
          {evidenceLinks([asset.sourcePath, ...asset.evidencePaths])}
        </div>
      </div>
    </Modal>
  );
}
