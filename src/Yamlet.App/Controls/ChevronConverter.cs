using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media;

namespace Yamlet.App.Controls;

/// <summary>
/// Maps a section's expanded state to a disclosure chevron geometry: a down-chevron
/// when expanded, a right-chevron when collapsed.
/// </summary>
public sealed class ChevronConverter : IValueConverter
{
    public static readonly ChevronConverter Instance = new();

    private static readonly Geometry Down = StreamGeometry.Parse(
        "M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z");
    private static readonly Geometry Right = StreamGeometry.Parse(
        "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z");

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is true ? Down : Right;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}
