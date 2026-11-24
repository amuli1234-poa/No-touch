import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Empty } from './UI';

/**
 * Catches a render error in a page so one broken page cannot blank the console.
 *
 * Without a boundary a thrown render error unmounts the whole React tree, which
 * is what a stale API response used to do to the dashboard: a successful login
 * followed by a white screen, with the sidebar and sign-out link gone too. The
 * boundary is mounted around page content, inside the shell, so navigation stays
 * usable and the failure is reported honestly instead of silently.
 *
 * `resetKey` re-arms the boundary when it changes, so navigating to another
 * route clears a previous failure rather than pinning the error view.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console so the underlying defect stays diagnosable; nothing
    // here is user-facing.
    console.error('Admin page render failed', error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <Empty title="This page failed to render">
          The console hit an unexpected error while drawing this page, so it cannot show
          accurate figures. Other pages remain available from the navigation. Reloading
          may help; if it persists, the backend and this console may be running different
          versions.
          <div className="mono" style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
            {this.state.error.message}
          </div>
        </Empty>
      );
    }
    return this.props.children;
  }
}
