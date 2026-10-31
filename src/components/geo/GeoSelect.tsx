'use client';

import type { Ref, RefObject } from 'react';
import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Portal,
} from '@headlessui/react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import './geo-select.css';

type Props<T extends string> = {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  loading?: boolean;
  portalTarget?: RefObject<HTMLElement | null>;
};

export default function GeoSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
  id,
  name,
  className,
  buttonRef,
  loading,
  portalTarget,
}: Props<T>) {
  const control = (
    <Listbox
      value={value}
      onChange={(next) => {
        if (next !== value) onChange(next);
      }}
      disabled={disabled || loading}
      name={name}
    >
      <ListboxButton
        type="button"
        id={id}
        ref={buttonRef}
        className={['og-select-button', className].filter(Boolean).join(' ')}
        aria-label={label}
      >
        <span>
          {options.find((option) => option.value === value)?.label ?? value}
        </span>
        {loading ? (
          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
        ) : (
          <ChevronDown size={15} aria-hidden="true" />
        )}
      </ListboxButton>
      <ListboxOptions
        anchor="bottom start"
        modal={false}
        className="og-select-options"
      >
        {options.map((option) => (
          <ListboxOption
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className="og-select-option"
          >
            {({ selected }) => (
              <>
                <span>{option.label}</span>
                {selected && <Check size={15} aria-hidden="true" />}
              </>
            )}
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
  return portalTarget ? (
    <Portal.Group target={portalTarget}>{control}</Portal.Group>
  ) : (
    control
  );
}
