using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media;

namespace Yamlet.App.Controls;

/// <summary>Maps a response status category (set by the editor VM) to a color.</summary>
public sealed class StatusCategoryToBrushConverter : IValueConverter
{
    public static readonly StatusCategoryToBrushConverter Instance = new();

    // Pastel, low-saturation status colors (paired with dark badge text).
    private static readonly IBrush Success = Brush("#FF8FD3A8");
    private static readonly IBrush Redirect = Brush("#FF9CC0EC");
    private static readonly IBrush ClientError = Brush("#FFE6CF8A");
    private static readonly IBrush ServerError = Brush("#FFE8A39C");
    private static readonly IBrush Neutral = Brush("#FFB4B2A6");

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => (value as string) switch
        {
            "success" => Success,
            "redirect" => Redirect,
            "clienterror" => ClientError,
            "servererror" => ServerError,
            "error" => ServerError,
            _ => Neutral,
        };

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();

    private static IBrush Brush(string hex) => new SolidColorBrush(Color.Parse(hex));
}
