interface Props {
  title?: string;
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = "Error",
  message = "Something went wrong. Please try again.",
  onRetry,
}: Props) {
  return (
    <div className="card text-center py-8">
      <p className="text-danger font-medium">{title}</p>
      <p className="text-muted text-sm mt-1">{message}</p>
      {onRetry && (
        <button
          className="mt-4 px-4 py-2 bg-accent text-white rounded-md text-sm hover:opacity-90"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}
