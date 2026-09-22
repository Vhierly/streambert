import { useState, useEffect, useCallback } from "react";
import {
  getCustomMetadata,
  setCustomMetadata,
  deleteCustomMetadata,
  getCustomTags,
  addCustomTag,
  removeCustomTag,
} from "../utils/customMetadata";
import { CloseIcon, TrashIcon, TagIcon } from "./Icons";
import { imgUrl } from "../utils/api";

export default function CustomMetadataModal({ mediaType, item, onClose }) {
  const [title, setTitle] = useState("");
  const [overview, setOverview] = useState("");
  const [posterUrl, setPosterUrl] = useState("");
  const [tags, setTags] = useState([]);
  const [newTag, setNewTag] = useState("");
  const [hasCustom, setHasCustom] = useState(false);
  const [saved, setSaved] = useState(false);

  // Load existing custom metadata
  useEffect(() => {
    const meta = getCustomMetadata(mediaType, item.id);
    if (meta) {
      setTitle(meta.title || meta.name || "");
      setOverview(meta.overview || meta.synopsis || "");
      setPosterUrl(meta.posterUrl || meta.poster_path || "");
      setTags(meta.tags || []);
      setHasCustom(true);
    } else {
      // Default to TMDB values
      setTitle(item.title || item.name || "");
      setOverview(item.overview || "");
      setPosterUrl(item.poster_path ? imgUrl(item.poster_path, "w500") : "");
      setTags([]);
    }
  }, [mediaType, item]);

  const handleSave = useCallback(() => {
    const metadata = {
      title,
      overview,
      posterUrl,
      tags,
      originalTitle: item.title || item.name,
      originalPoster: item.poster_path,
    };
    setCustomMetadata(mediaType, item.id, metadata);
    setHasCustom(true);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [mediaType, item, title, overview, posterUrl, tags]);

  const handleDelete = useCallback(() => {
    deleteCustomMetadata(mediaType, item.id);
    setHasCustom(false);
    setTitle(item.title || item.name || "");
    setOverview(item.overview || "");
    setPosterUrl(item.poster_path ? imgUrl(item.poster_path, "w500") : "");
    setTags([]);
  }, [mediaType, item]);

  const handleAddTag = useCallback(() => {
    const tag = newTag.trim();
    if (!tag) return;
    if (!tags.includes(tag)) {
      const newTags = [...tags, tag];
      setTags(newTags);
      addCustomTag(mediaType, item.id, tag);
    }
    setNewTag("");
  }, [newTag, tags, mediaType, item]);

  const handleRemoveTag = useCallback(
    (tag) => {
      const newTags = tags.filter((t) => t !== tag);
      setTags(newTags);
      removeCustomTag(mediaType, item.id, tag);
    },
    [tags, mediaType, item],
  );

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-box" style={{ maxWidth: 560, width: "92vw" }}>
        {/* Header */}
        <div className="modal-header">
          <div>
            <h2>Edit Metadata</h2>
            <p className="modal-sub">
              Override TMDB data locally — your changes stay on this device
            </p>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {/* Poster preview */}
        <div className="cm-poster-row">
          <div className="cm-poster-preview">
            {posterUrl ? (
              <img src={posterUrl} alt="Poster preview" />
            ) : (
              <div className="cm-poster-placeholder">No poster</div>
            )}
          </div>
          <div className="cm-poster-input">
            <label>Poster URL</label>
            <input
              type="text"
              className="apikey-input"
              placeholder="https://image.tmdb.org/t/p/w500/..."
              value={posterUrl}
              onChange={(e) => setPosterUrl(e.target.value)}
            />
          </div>
        </div>

        {/* Title */}
        <div className="cm-field">
          <label>Title</label>
          <input
            type="text"
            className="apikey-input"
            placeholder={item.title || item.name || "Title"}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Overview */}
        <div className="cm-field">
          <label>Overview / Synopsis</label>
          <textarea
            className="apikey-input"
            rows={4}
            placeholder="Description..."
            value={overview}
            onChange={(e) => setOverview(e.target.value)}
            style={{ resize: "vertical", minHeight: 80 }}
          />
        </div>

        {/* Tags */}
        <div className="cm-field">
          <label>
            <TagIcon /> Tags
          </label>
          <div className="cm-tags">
            {tags.map((tag) => (
              <span key={tag} className="cm-tag">
                {tag}
                <button
                  className="cm-tag-remove"
                  onClick={() => handleRemoveTag(tag)}
                  title="Remove tag"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div className="cm-tag-input-row">
            <input
              type="text"
              className="apikey-input"
              placeholder="Add a tag..."
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
            />
            <button className="btn btn-ghost" onClick={handleAddTag}>
              Add
            </button>
          </div>
        </div>

        {/* Original values reference */}
        <div className="cm-original">
          <div className="cm-original-label">Original TMDB values:</div>
          <div className="cm-original-title">{item.title || item.name}</div>
          {item.overview && (
            <div className="cm-original-overview">{item.overview.slice(0, 120)}...</div>
          )}
        </div>

        {/* Actions */}
        <div className="cm-actions">
          <button className="btn btn-primary" onClick={handleSave}>
            {hasCustom ? "Update" : "Save"} Custom Metadata
          </button>
          {hasCustom && (
            <button className="btn btn-ghost" onClick={handleDelete}>
              <TrashIcon /> Reset to TMDB
            </button>
          )}
          {saved && (
            <span style={{ fontSize: 13, color: "#48c774" }}>✓ Saved</span>
          )}
        </div>
      </div>
    </div>
  );
}
