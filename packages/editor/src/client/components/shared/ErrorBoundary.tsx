import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort fallback for a render-time exception anywhere in the tree.
 * Without this, React unmounts the whole app on an uncaught error and the
 * user is left staring at a blank page with no way back short of a manual
 * reload — this at least gives them that reload as a button, plus enough
 * detail to report the bug.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary-screen">
        <div className="error-boundary-panel">
          <h2>Something went wrong</h2>
          <p>
            Flowbun hit an unexpected error and can't keep rendering this view.
            Your flows are safe — they're stored on the server, not in this tab.
          </p>
          <pre className="error-boundary-message">{error.message}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
