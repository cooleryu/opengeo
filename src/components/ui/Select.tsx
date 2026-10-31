'use client';

import GeoSelect from '@/components/geo/GeoSelect';
import { cn } from '@/lib/utils';
import { forwardRef } from 'react';

interface SelectProps {
  label: string;
  id?: string;
  className?: string;
  value?: string | number | null;
  onChange: (value: string) => void;
  options: { value: string | number; label: string; disabled?: boolean }[];
  loading?: boolean;
  disabled?: boolean;
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    { label, id, className, value, onChange, options, loading = false, disabled },
    ref,
  ) => {
    const normalizedOptions = options.map((option) => ({
      ...option,
      value: String(option.value),
    }));
    const selectedValue =
      normalizedOptions.find((option) => option.value === String(value))?.value ??
      normalizedOptions.find((option) => !option.disabled)?.value ??
      '';

    return (
      <div className="relative inline-flex w-full items-center">
        <GeoSelect
          label={label}
          id={id}
          buttonRef={ref}
          value={selectedValue}
          onChange={onChange}
          options={normalizedOptions}
          loading={loading}
          disabled={disabled}
          className={cn('!text-xs lg:!text-sm', className)}
        />
      </div>
    );
  },
);

Select.displayName = 'Select';

export default Select;
