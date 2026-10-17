import React from 'react';
import { AppErrorPage } from '@/pages/error-page';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[Daylight] render error', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <AppErrorPage
          detail={this.state.error?.message || '页面渲染失败。'}
          onRetry={() => {
            this.setState({ error: null });
            window.location.assign(this.props.fallbackPath || '/app');
          }}
        />
      );
    }
    return this.props.children;
  }
}
