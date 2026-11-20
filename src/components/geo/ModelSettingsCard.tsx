'use client';

import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { GeoConnectionSettings } from '@/lib/geo/connection-settings-types';
import GeoSelect from './GeoSelect';
import { useUiLanguage } from './UiLanguageContext';
import './connection-settings.css';

type ModelDraft = {
  provider: 'gemini' | 'deepseek' | 'openai' | 'custom';
  model: string;
  baseURL: string;
  apiKey: string;
};

type Feedback = { error?: string; message?: string };

const modelDraft = (model: GeoConnectionSettings['model']): ModelDraft => ({
  provider: model.provider,
  model: model.model,
  baseURL: model.baseURL,
  apiKey: '',
});

const presets = {
  gemini: {
    model: 'gemini-3.8-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  deepseek: { model: 'deepseek-flash', baseURL: 'https://api.deepseek.com' },
  openai: { model: '', baseURL: 'https://api.openai.com/v1' },
};

export type ModelSettingsCardProps = {
  initialSettings?: GeoConnectionSettings | null;
  onSaved?: (next: GeoConnectionSettings) => void;
  onboardingGate?: boolean;
};

export default function ModelSettingsCard({
  initialSettings,
  onSaved,
  onboardingGate = false,
}: ModelSettingsCardProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';

  const [settings, setSettings] = useState<GeoConnectionSettings | null>(
    initialSettings ?? null,
  );
  const [model, setModel] = useState<ModelDraft>(() =>
    initialSettings
      ? modelDraft(initialSettings.model)
      : { provider: 'custom', model: '', baseURL: '', apiKey: '' },
  );
  const [modelDirty, setModelDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [loadError, setLoadError] = useState('');
  const [feedback, setFeedback] = useState<Feedback>({});
  const [testConfirmation, setTestConfirmation] = useState(false);

  useEffect(() => {
    if (initialSettings) {
      setSettings(initialSettings);
      setModel(modelDraft(initialSettings.model));
      setModelDirty(false);
      return;
    }
    const controller = new AbortController();
    fetch('/api/geo/settings', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(
            body.error ||
              (isEn ? 'Failed to load settings.' : '读取设置失败。'),
          );
        }
        return body as GeoConnectionSettings;
      })
      .then((next) => {
        setSettings(next);
        setModel(modelDraft(next.model));
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error
              ? error.message
              : isEn
                ? 'Failed to load settings.'
                : '读取设置失败。',
          );
        }
      });
    return () => controller.abort();
  }, [initialSettings, isEn]);

  async function save(values: ModelDraft) {
    setBusy('save');
    setFeedback({});
    try {
      const response = await fetch('/api/geo/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: 'model', values }),
      });
      const next = await response.json();
      if (!response.ok) {
        throw new Error(
          next.error ||
            (isEn ? 'Save failed. Please try again.' : '保存失败，请重试。'),
        );
      }
      setSettings(next);
      setModel(modelDraft(next.model));
      setModelDirty(false);
      setTestConfirmation(false);
      setFeedback({
        message: isEn
          ? 'Saved. New AI actions will use this model.'
          : '已保存，新发起的 AI 操作将使用此配置。',
      });
      onSaved?.(next);
    } catch (error) {
      setFeedback({
        error:
          error instanceof Error
            ? error.message
            : isEn
              ? 'Save failed.'
              : '保存失败。',
      });
    } finally {
      setBusy('');
    }
  }

  async function testConnection() {
    setBusy('test');
    setTestConfirmation(false);
    setFeedback({});
    try {
      const response = await fetch('/api/geo/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: 'model', acknowledgeCost: true }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(
          result.error ||
            result.message ||
            (isEn ? 'Connection test failed.' : '测试未通过。'),
        );
      }
      setFeedback({ message: result.message });
    } catch (error) {
      setFeedback({
        error:
          error instanceof Error
            ? error.message
            : isEn
              ? 'Connection test failed.'
              : '测试失败。',
      });
    } finally {
      setBusy('');
    }
  }

  if (loadError) {
    return (
      <div className="cs-feedback cs-error" role="alert">
        {loadError}
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="cs-loading">
        <Loader2 size={18} className="spin" />
        {isEn ? 'Loading settings…' : '正在读取设置…'}
      </div>
    );
  }

  const isConfigured = Boolean(
    settings.modelConfigured ?? settings.model.configured,
  );
  const changedDestination =
    model.provider !== settings.model.provider ||
    model.baseURL.replace(/\/$/, '') !==
      settings.model.baseURL.replace(/\/$/, '');

  return (
    <section
      id="model"
      className="cs-model-card"
      aria-labelledby="cs-model-title"
    >
      <header className="cs-section-heading">
        <div>
          <h3 id="cs-model-title">
            {onboardingGate
              ? isEn
                ? 'Connect an AI model first'
                : '先连接一个 AI 模型'
              : isEn
                ? 'API model'
                : 'API 模型'}
          </h3>
          <p>
            {onboardingGate
              ? isEn
                ? 'Save an API key to analyze your site, generate buyer questions, and draft actions.'
                : '保存 API Key 后，即可分析你的产品、生成买家问题并起草行动建议。'
              : isEn
                ? 'Used for buyer questions, analysis, drafts, and independent review.'
                : '用于问题生成、分析、撰写草稿与独立审核。'}
          </p>
        </div>
        <span className={`cs-status ${isConfigured ? 'cs-configured' : ''}`}>
          {isConfigured
            ? isEn
              ? 'Configured'
              : '已配置'
            : isEn
              ? 'Not configured'
              : '未配置'}
        </span>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save(model);
        }}
      >
        <div className="cs-fields">
          <label>
            {isEn ? 'Provider' : '服务商'}
            <GeoSelect<ModelDraft['provider']>
              label={isEn ? 'Model provider' : '模型服务商'}
              value={model.provider}
              disabled={!!busy}
              onChange={(provider) => {
                setModel((previous) => ({
                  ...previous,
                  provider,
                  ...(provider === 'custom' ? {} : presets[provider]),
                  apiKey: '',
                }));
                setModelDirty(true);
                setTestConfirmation(false);
                setFeedback({});
              }}
              options={[
                { value: 'gemini', label: 'Google Gemini' },
                { value: 'deepseek', label: 'DeepSeek' },
                { value: 'openai', label: 'OpenAI / GPT' },
                {
                  value: 'custom',
                  label: isEn ? 'Other compatible API' : '其他兼容接口',
                },
              ]}
            />
          </label>
          <label>
            {isEn ? 'Model' : '模型'}
            <input
              value={model.model}
              required
              autoComplete="off"
              placeholder={isEn ? 'Enter model name' : '填写模型名称'}
              onChange={(event) => {
                setModel({ ...model, model: event.target.value });
                setModelDirty(true);
                setFeedback({});
              }}
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={model.apiKey}
              autoComplete="new-password"
              spellCheck={false}
              required={!settings.model.keyConfigured || changedDestination}
              placeholder={
                settings.model.keyConfigured && !changedDestination
                  ? isEn
                    ? 'Saved — leave blank to keep'
                    : '已设置，留空保留'
                  : isEn
                    ? 'Enter API Key'
                    : '填写 API Key'
              }
              onChange={(event) => {
                setModel({ ...model, apiKey: event.target.value });
                setModelDirty(true);
                setFeedback({});
              }}
            />
          </label>
        </div>
        <details
          className="cs-advanced"
          open={model.provider === 'custom' || undefined}
        >
          <summary>{isEn ? 'API endpoint' : '接口地址'}</summary>
          <label>
            {isEn ? 'API base URL' : 'API 地址'}
            <input
              type="url"
              required
              value={model.baseURL}
              autoComplete="off"
              onChange={(event) => {
                setModel({ ...model, baseURL: event.target.value });
                setModelDirty(true);
                setFeedback({});
              }}
            />
          </label>
        </details>
        {changedDestination && settings.model.keyConfigured && (
          <p className="cs-hint">
            {isEn
              ? 'Enter the API key for the new provider or endpoint.'
              : '更换服务商或地址时，请填写对应的新 API Key。'}
          </p>
        )}
        <div className="cs-actions">
          <button
            className="cs-button cs-primary"
            type="submit"
            disabled={!!busy || !modelDirty}
          >
            {busy === 'save' && <Loader2 size={14} className="spin" />}
            {isEn ? 'Save' : '保存'}
          </button>
          <button
            className="cs-button"
            type="button"
            disabled={!!busy || !settings.model.configured || modelDirty}
            onClick={() => setTestConfirmation(true)}
          >
            {busy === 'test' && <Loader2 size={14} className="spin" />}
            {isEn ? 'Test connection' : '测试连接'}
          </button>
          {modelDirty && (
            <span className="cs-hint">
              {isEn ? 'Unsaved changes' : '有未保存的修改'}
            </span>
          )}
        </div>
        {testConfirmation && (
          <div
            className="cs-confirm"
            role="group"
            aria-label={isEn ? 'Confirm connection test' : '确认测试连接'}
          >
            <span>
              {isEn
                ? 'Send one test request using the saved configuration (may incur API usage cost).'
                : '使用已保存配置发送一次测试请求，可能产生对应接口费用。'}
            </span>
            <button
              type="button"
              className="cs-button"
              onClick={() => void testConnection()}
              disabled={!!busy}
            >
              {isEn ? 'Confirm test' : '确认测试'}
            </button>
            <button
              type="button"
              className="cs-link"
              onClick={() => setTestConfirmation(false)}
            >
              {isEn ? 'Cancel' : '取消'}
            </button>
          </div>
        )}
        {(feedback.error || feedback.message) && (
          <p
            className={`cs-feedback ${feedback.error ? 'cs-error' : ''}`}
            role={feedback.error ? 'alert' : 'status'}
          >
            {!feedback.error && <Check size={14} />}
            {feedback.error || feedback.message}
          </p>
        )}
      </form>
    </section>
  );
}
