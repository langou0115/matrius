import { useState } from 'react';

import { AppFrame } from '@/components/web/app-frame';
import { AppearanceProvider } from '@/theme/appearance';
import { ChangePasswordDialog } from './change-password-dialog';
import { LoginDialog } from './login-dialog';
import { useAuth } from './auth-state';

/** Authentication protects every production route, including settings and deep links. */
export function InstanceLogin() {
  const auth = useAuth();
  const [open, setOpen] = useState(true);
  return <AppearanceProvider><AppFrame>
    <main className="storage-screen">
      <strong>Matrius</strong>
      <p>登录以访问你的单用户实例。</p>
      <button className="primary-button" onClick={() => setOpen(true)}>登录实例</button>
      {open && (auth.user?.mustChangePassword
        ? <ChangePasswordDialog onClose={() => { setOpen(false); void auth.logout().catch(() => {}); }} onSuccess={() => setOpen(false)} />
        : <LoginDialog onClose={() => setOpen(false)} />)}
    </main>
  </AppFrame></AppearanceProvider>;
}
