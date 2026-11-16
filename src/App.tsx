import { useEffect } from 'react';
import { useApp } from './store';
import { Library } from './components/Library';
import { ProjectView } from './components/ProjectView';
import { requestPersistence } from './db';

export function App() {
  const ready = useApp((s) => s.ready);
  const route = useApp((s) => s.route);
  const project = useApp((s) => s.project);
  const toast = useApp((s) => s.toast);
  const theme = useApp((s) => s.settings.theme);

  useEffect(() => {
    useApp.getState().init();
    requestPersistence();
  }, []);

  useEffect(() => {
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, [theme]);

  if (!ready) return <div className="splash"><div className="spinner" />FluidNotes</div>;
  return (
    <>
      {route.name === 'project' && project ? <ProjectView /> : <Library />}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
