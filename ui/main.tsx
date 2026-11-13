import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { RouterNavigationBridge } from '@/router';
import { AppRoutes } from '@/router/routes';

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing the #root container.');

createRoot(container).render(
  <BrowserRouter>
    <RouterNavigationBridge />
    <AppRoutes />
  </BrowserRouter>,
);
