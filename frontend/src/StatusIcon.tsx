export default function StatusIcon({ kind }: { kind: "warning" | "clock" | "error" }) {
    return <svg className="status-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {kind === "warning" ? <><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5m0 3h.01" /></> : <><circle cx="12" cy="12" r="9" />{kind === "clock" ? <path d="M12 7v5l3 2" /> : <path d="m9 9 6 6m0-6-6 6" />}</>}
    </svg>;
}
