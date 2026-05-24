using System.Text.RegularExpressions;
using Yamlet.App.Models;

namespace Yamlet.App.Services;

/// <summary>
/// The set of variable scopes available when resolving a request, in ascending order
/// of precedence. Build one with <see cref="Builder"/> and the layers are merged so
/// request-level values win over collection, then environment, then globals.
/// </summary>
public sealed class VariableContext
{
    private readonly Dictionary<string, string> _merged;

    private VariableContext(Dictionary<string, string> merged) => _merged = merged;

    public bool TryGet(string key, out string value) => _merged.TryGetValue(key, out value!);

    public IReadOnlyDictionary<string, string> Values => _merged;

    public static VariableContext Empty { get; } = new(new(StringComparer.OrdinalIgnoreCase));

    public static VariableContext FromDictionary(IDictionary<string, string> values) =>
        new(new Dictionary<string, string>(values, StringComparer.OrdinalIgnoreCase));

    /// <summary>
    /// Fluent builder that layers scopes lowest-precedence first. Later layers
    /// overwrite earlier ones, so call order encodes precedence.
    /// </summary>
    public sealed class Builder
    {
        private readonly Dictionary<string, string> _values = new(StringComparer.OrdinalIgnoreCase);

        public Builder AddLayer(IEnumerable<YamletVariable>? variables)
        {
            if (variables is null)
            {
                return this;
            }

            foreach (var v in variables)
            {
                if (v.Enabled && !string.IsNullOrEmpty(v.Key))
                {
                    _values[v.Key] = v.Value ?? string.Empty;
                }
            }

            return this;
        }

        public VariableContext Build() => new(_values);
    }

    /// <summary>
    /// Convenience constructor applying Yamlet's precedence: globals (lowest) →
    /// environment → collection → request (highest).
    /// </summary>
    public static VariableContext Create(
        IEnumerable<YamletVariable>? globals,
        IEnumerable<YamletVariable>? environment,
        IEnumerable<YamletVariable>? collection,
        IEnumerable<YamletVariable>? request)
        => new Builder()
            .AddLayer(globals)
            .AddLayer(environment)
            .AddLayer(collection)
            .AddLayer(request)
            .Build();
}

/// <summary>
/// Replaces <c>{{name}}</c> placeholders in strings using a <see cref="VariableContext"/>.
/// Unknown placeholders are left untouched so missing variables are visible rather
/// than silently blanked. Resolution is single-pass (no recursive expansion).
/// </summary>
public sealed class VariableResolver
{
    private static readonly Regex PlaceholderPattern =
        new(@"\{\{\s*([^{}\s]+)\s*\}\}", RegexOptions.Compiled);

    public string Resolve(string? input, VariableContext context)
    {
        if (string.IsNullOrEmpty(input))
        {
            return input ?? string.Empty;
        }

        return PlaceholderPattern.Replace(input, match =>
        {
            var key = match.Groups[1].Value;
            if (context.TryGet(key, out var value))
            {
                return value;
            }

            // User variables win; fall back to Postman-style dynamic variables ($guid,
            // $timestamp, $random*) — each occurrence generates a fresh value.
            if (DynamicVariables.TryGenerate(key, out var generated))
            {
                return generated;
            }

            return match.Value;
        });
    }
}
