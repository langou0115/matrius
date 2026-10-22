import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { useState, type ComponentProps } from 'react';

type Props = Omit<ComponentProps<'input'>, 'type' | 'className'> & { label: string };

export function PasswordInput({ label, ...props }: Props) {
  const [visible, setVisible] = useState(false);
  const action = `${visible ? '隐藏' : '显示'}${label}`;
  return <span className="login-input-wrap">
    <LockKeyhole size={17} strokeWidth={1.75} aria-hidden="true" />
    <input {...props} aria-label={label} className="text-field" type={visible ? 'text' : 'password'} />
    <button type="button" className="login-password-toggle" aria-label={action} title={action}
      aria-pressed={visible} onClick={() => setVisible((value) => !value)}>
      {visible ? <Eye size={17} strokeWidth={1.75} aria-hidden="true" /> : <EyeOff size={17} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  </span>;
}
