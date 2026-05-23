namespace Yamlet.App.ViewModels;

/// <summary>
/// Pairs a display label with an underlying value for use as ComboBox items, so the
/// UI can show friendly text (e.g. "x-www-form-urlencoded") while binding to an enum.
/// </summary>
public sealed class LabeledOption<T>
{
    public LabeledOption(string label, T value)
    {
        Label = label;
        Value = value;
    }

    public string Label { get; }
    public T Value { get; }

    public override string ToString() => Label;
}
