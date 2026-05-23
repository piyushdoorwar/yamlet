using System;
using System.Threading.Tasks;

namespace Yamlet.App.Controls;

/// <summary>
/// Surface a <see cref="CodeEditorView"/> uses to highlight and inspect
/// <c>{{name}}</c> placeholders: it can tell whether a variable resolves, read its
/// current value, and write a new value back to the active scope. View models that
/// own a request's variable context implement this so the body editor can offer
/// Postman-style inline variable management.
/// </summary>
public interface IVariableSource
{
    /// <summary>Resolves <paramref name="name"/> against the merged variable scopes.</summary>
    bool TryGetValue(string name, out string value);

    /// <summary>Human-readable name of the scope edits are written to (e.g. the active environment).</summary>
    string TargetScopeName { get; }

    /// <summary>Sets <paramref name="name"/> to <paramref name="value"/> in the target scope and persists it.</summary>
    Task SetAsync(string name, string value);

    /// <summary>Raised after the variable set changes, so editors can re-highlight.</summary>
    event EventHandler? VariablesChanged;
}
