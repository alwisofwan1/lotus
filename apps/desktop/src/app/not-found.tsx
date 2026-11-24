export default function NotFound() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        flexDirection: "column",
        gap: "1rem",
        fontFamily: "system-ui, sans-serif",
        color: "rgba(255,255,255,0.7)",
      }}
    >
      <h1 style={{ fontSize: "3rem", fontWeight: "bold", margin: 0 }}>404</h1>
      <p style={{ margin: 0 }}>Page not found</p>
    </div>
  );
}
