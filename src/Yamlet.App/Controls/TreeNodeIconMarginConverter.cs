using System.Globalization;
using Avalonia;
using Avalonia.Data.Converters;

namespace Yamlet.App.Controls;

/// <summary>
/// Keeps collection icons aligned when Avalonia's TreeView changes the header offset
/// between collapsed and expanded states.
/// </summary>
public sealed class TreeNodeIconMarginConverter : IValueConverter
{
    public static readonly TreeNodeIconMarginConverter Instance = new();

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is true
            ? new Thickness(-24, 0, 0, 0)
            : new Thickness(-12, 0, 0, 0);

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}

/// <summary>Stable compact margin for folder rows; folder indentation already comes from the tree level.</summary>
public sealed class FolderNodeIconMarginConverter : IValueConverter
{
    public static readonly FolderNodeIconMarginConverter Instance = new();

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        new Thickness(-12, 0, 0, 0);

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        throw new NotSupportedException();
}
