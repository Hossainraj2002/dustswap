'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    this.setState({
      error: error,
      errorInfo: errorInfo
    });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 m-8 bg-red-900/50 border border-red-500 rounded-xl text-white">
          <h1 className="text-2xl font-bold mb-4 font-mono">Fatal UI Crash Detected!</h1>
          <p className="mb-4">Please copy this EXACT text and send it to the AI assistant:</p>
          <pre className="p-4 bg-black/50 rounded overflow-x-auto text-sm text-red-300">
            {this.state.error?.toString()}
          </pre>
          <pre className="mt-4 p-4 bg-black/50 rounded overflow-x-auto text-xs text-red-200 opacity-80">
            {this.state.errorInfo?.componentStack}
          </pre>
          <button 
             onClick={() => this.setState({ hasError: false })}
             className="mt-6 bg-white/20 px-4 py-2 rounded hover:bg-white/30"
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
