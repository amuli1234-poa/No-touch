import React from 'react';
import PropTypes from 'prop-types';
import ErrorComponent from './index';

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    componentDidCatch = (error, info) => {
        // Keep the original React exception visible in DevTools. The fallback
        // screen intentionally has a generic message, so without this the cause
        // of route-specific crashes (such as Transactions) is hidden.
        console.error('[Deriv Bot] Unhandled React error:', error, info);
        if (window.TrackJS) window.TrackJS.console.log(this.props.root_store);

        this.setState({
            hasError: true,
            error,
            info,
        });
    };
    render = () =>
        this.state.hasError ? (
            <ErrorComponent should_show_refresh={true} error_message={this.state.error?.message || String(this.state.error)} />
        ) : (
            this.props.children
        );
}

ErrorBoundary.propTypes = {
    root_store: PropTypes.object,
    children: PropTypes.oneOfType([PropTypes.string, PropTypes.arrayOf(PropTypes.node), PropTypes.node]),
};

export default ErrorBoundary;
