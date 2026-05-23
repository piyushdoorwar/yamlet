using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media;

namespace Yamlet.App.Controls;

/// <summary>Maps an HTTP method name to its badge color.</summary>
public sealed class MethodToBrushConverter : IValueConverter
{
    public static readonly MethodToBrushConverter Instance = new();

    // Pastel, low-saturation method colors (paired with dark badge text).
    private static readonly IBrush Get = Brush("#FF8FD3A8");
    private static readonly IBrush Post = Brush("#FFE6CF8A");
    private static readonly IBrush Put = Brush("#FF9CC0EC");
    private static readonly IBrush Patch = Brush("#FFC3A9E8");
    private static readonly IBrush Delete = Brush("#FFE8A39C");
    private static readonly IBrush Other = Brush("#FFB4B2A6");

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => (value as string)?.ToUpperInvariant() switch
        {
            "GET" => Get,
            "POST" => Post,
            "PUT" => Put,
            "PATCH" => Patch,
            "DELETE" => Delete,
            _ => Other,
        };

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();

    private static IBrush Brush(string hex) => new SolidColorBrush(Color.Parse(hex));
}
