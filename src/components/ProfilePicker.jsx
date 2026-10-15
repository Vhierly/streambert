import { useState } from "react";

const AVATAR_COLORS = ["#e50914", "#0071eb", "#22c55e", "#f59e0b", "#8b5cf6", "#ec4899"];

function ProfileAvatar({ name, color, size = 80 }) {
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <div
      className="profile-avatar"
      style={{
        width: size,
        height: size,
        background: color || AVATAR_COLORS[0],
        fontSize: size * 0.4,
      }}
    >
      {initial}
    </div>
  );
}

export default function ProfilePicker({ profiles, currentId, onCreate, onSwitch, onDelete, onClose }) {
  const [mode, setMode] = useState("pick"); // "pick" | "create"
  const [name, setName] = useState("");
  const [color, setColor] = useState(AVATAR_COLORS[0]);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const handleCreate = () => {
    if (!name.trim()) return;
    onCreate({ name: name.trim(), color });
    setName("");
    setMode("pick");
  };

  return (
    <div className="profile-picker-overlay" onClick={onClose}>
      <div className="profile-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="profile-picker-title">
          {mode === "create" ? "Add Profile" : "Who's watching?"}
        </div>

        {mode === "pick" && (
          <>
            <div className="profile-picker-grid">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className={`profile-picker-item ${p.id === currentId ? "active" : ""}`}
                  onClick={() => {
                    if (p.id !== currentId) onSwitch(p.id);
                    onClose();
                  }}
                >
                  <ProfileAvatar name={p.name} color={p.color} />
                  <span className="profile-picker-name">{p.name}</span>
                  {p.id === currentId && <span className="profile-active-badge">✓</span>}
                  {profiles.length > 1 && (
                    <button
                      className="profile-delete-btn"
                      title={`Delete ${p.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteConfirm(p.id);
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              <div className="profile-picker-item profile-add" onClick={() => setMode("create")}>
                <div className="profile-add-icon">+</div>
                <span className="profile-picker-name">Add Profile</span>
              </div>
            </div>
            {deleteConfirm && (
              <div className="profile-delete-confirm">
                <p>Delete "{profiles.find((p) => p.id === deleteConfirm)?.name}"?</p>
                <p className="profile-delete-warn">History, library, and settings will be lost.</p>
                <div className="profile-delete-actions">
                  <button className="btn btn-danger" onClick={() => { onDelete(deleteConfirm); setDeleteConfirm(null); }}>
                    Delete
                  </button>
                  <button className="btn" onClick={() => setDeleteConfirm(null)}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}

        {mode === "create" && (
          <div className="profile-create-form">
            <div className="profile-create-preview">
              <ProfileAvatar name={name || "?"} color={color} size={60} />
            </div>
            <input
              className="profile-name-input"
              placeholder="Profile name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              autoFocus
            />
            <div className="profile-color-row">
              {AVATAR_COLORS.map((c) => (
                <button
                  key={c}
                  className={`profile-color-swatch ${c === color ? "selected" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
            <div className="profile-create-actions">
              <button className="btn btn-primary" onClick={handleCreate} disabled={!name.trim()}>
                Save
              </button>
              <button className="btn" onClick={() => { setMode("pick"); setName(""); }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
